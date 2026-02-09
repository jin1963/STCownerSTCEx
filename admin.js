(() => {
  "use strict";
  const C = window.APP_CONFIG;
  if (!C) throw new Error("Missing config.js (window.APP_CONFIG)");

  const $ = (id) => document.getElementById(id);
  const setStatus = (t) => { $("status").textContent = t; };

  const ERC20_ABI = [
    "function decimals() view returns(uint8)",
    "function balanceOf(address) view returns(uint256)",
  ];

  // ✅ ตรง ABI ของ 0xbb6F...
  const STAKE_ABI = [
    "function owner() view returns(address)",
    "function stcexPerUsdt() view returns(uint256)",
    "function stcPerStcex() view returns(uint256)",
    "function minStakeSTCEx() view returns(uint256)",
    "function lockSeconds() view returns(uint256)",
    "function periodSeconds() view returns(uint256)",
    "function rewardBps() view returns(uint256)",
    "function setParams(uint256,uint256,uint256,uint256,uint256,uint256)",
    "function ownerWithdrawToken(address,uint256)",
  ];

  let provider, signer, user;
  let stake, usdt, stcex, stc;
  let decUSDT=18, decSTCEx=18, decSTC=18;
  let ownerAddr = null;
  let isOwner = false;

  function toBN(x){
    const s = (x||"").toString().trim();
    if(!s) throw new Error("กรุณากรอกให้ครบ");
    // รองรับทั้งเลขธรรมดาและเลขยาว
    return BigInt(s);
  }

  function fmtUnits(v, dec, p=6){
    try{
      const s = ethers.formatUnits(v, dec);
      const n = Number(s);
      if(!isFinite(n)) return s;
      return n.toLocaleString(undefined,{maximumFractionDigits:p});
    }catch{ return "-"; }
  }

  async function ensureBSC(){
    if(!window.ethereum) throw new Error("ไม่พบ Wallet (MetaMask/Bitget)");
    const chainId = await window.ethereum.request({ method:"eth_chainId" });
    if(chainId !== C.CHAIN_ID_HEX){
      await window.ethereum.request({
        method:"wallet_switchEthereumChain",
        params:[{ chainId: C.CHAIN_ID_HEX }]
      });
    }
  }

  function setOwnerUI(){
    $("contract").textContent = C.CONTRACT;
    $("addrUSDT").textContent = C.USDT;
    $("addrSTCEx").textContent = C.STCEX;
    $("addrSTC").textContent = C.STC;

    $("owner").textContent = ownerAddr || "-";
    $("isOwner").textContent = isOwner ? "✅ YES" : "❌ NO";

    // enable/disable owner actions
    $("btnRefresh").disabled = !user;
    $("btnSetParams").disabled = !isOwner;
    $("btnTestMode").disabled = !isOwner;
    $("btnProdMode").disabled = !isOwner;
    $("btnWithdrawToken").disabled = !isOwner;

    $("btnFillUSDT").disabled = !isOwner;
    $("btnFillSTCEx").disabled = !isOwner;
    $("btnFillSTC").disabled = !isOwner;
  }

  async function refreshAll(){
    // balances in contract
    const [bU, bE, bS] = await Promise.all([
      usdt.balanceOf(C.CONTRACT),
      stcex.balanceOf(C.CONTRACT),
      stc.balanceOf(C.CONTRACT),
    ]);

    $("cUSDT").textContent  = fmtUnits(bU, decUSDT);
    $("cSTCEx").textContent = fmtUnits(bE, decSTCEx);
    $("cSTC").textContent   = fmtUnits(bS, decSTC);

    // params
    const [p1,p2,p3,p4,p5,p6] = await Promise.all([
      stake.stcexPerUsdt(),
      stake.stcPerStcex(),
      stake.minStakeSTCEx(),
      stake.lockSeconds(),
      stake.periodSeconds(),
      stake.rewardBps(),
    ]);

    $("p1").textContent = p1.toString();
    $("p2").textContent = p2.toString();
    $("p3").textContent = p3.toString();
    $("p4").textContent = p4.toString();
    $("p5").textContent = p5.toString();
    $("p6").textContent = p6.toString();

    // auto-fill inputs with current params (สะดวก)
    $("in1").value = p1.toString();
    $("in2").value = p2.toString();
    $("in3").value = p3.toString();
    $("in4").value = p4.toString();
    $("in5").value = p5.toString();
    $("in6").value = p6.toString();
  }

  async function connect(){
    try{
      await ensureBSC();
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
      user = await signer.getAddress();
      $("wallet").textContent = user;

      stake = new ethers.Contract(C.CONTRACT, STAKE_ABI, signer);
      usdt  = new ethers.Contract(C.USDT,  ERC20_ABI, signer);
      stcex = new ethers.Contract(C.STCEX, ERC20_ABI, signer);
      stc   = new ethers.Contract(C.STC,   ERC20_ABI, signer);

      decUSDT  = await usdt.decimals();
      decSTCEx = await stcex.decimals();
      decSTC   = await stc.decimals();

      ownerAddr = await stake.owner();
      isOwner = ownerAddr.toLowerCase() === user.toLowerCase();

      setOwnerUI();
      await refreshAll();

      setStatus(isOwner ? "เชื่อมต่อสำเร็จ ✅ (คุณเป็น Owner)" : "เชื่อมต่อสำเร็จ ✅ (แต่ไม่ใช่ Owner)");
    }catch(e){
      setStatus("เชื่อมต่อไม่สำเร็จ: " + (e?.shortMessage||e?.message||e));
    }
  }

  async function onRefresh(){
    try{
      if(!user) return setStatus("กรุณาเชื่อมต่อก่อน");
      ownerAddr = await stake.owner();
      isOwner = ownerAddr.toLowerCase() === user.toLowerCase();
      setOwnerUI();
      await refreshAll();
      setStatus("อัปเดตแล้ว ✅");
    }catch(e){
      setStatus("Refresh ไม่สำเร็จ: " + (e?.shortMessage||e?.message||e));
    }
  }

  async function onSetParams(){
    try{
      if(!isOwner) return setStatus("คุณไม่ใช่ Owner");
      const a = toBN($("in1").value);
      const b = toBN($("in2").value);
      const c = toBN($("in3").value);
      const d = toBN($("in4").value);
      const e = toBN($("in5").value);
      const f = toBN($("in6").value);

      const tx = await stake.setParams(a, b, c, d, e, f);
      setStatus("กำลัง setParams... " + tx.hash);
      await tx.wait();
      setStatus("setParams สำเร็จ ✅");
      await refreshAll();
    }catch(err){
      setStatus("setParams ไม่สำเร็จ: " + (err?.shortMessage||err?.message||err));
    }
  }

  async function onTestMode(){
    try{
      if(!isOwner) return setStatus("คุณไม่ใช่ Owner");
      // stcexPerUsdt=1e18, stcPerStcex=1000e18, minStake=10e18, lock=300, period=60, bps=1000
      const tx = await stake.setParams(
        1000000000000000000n,
        1000000000000000000000n,
        10000000000000000000n,
        300n,
        60n,
        1000n
      );
      setStatus("กำลังตั้ง Test Mode... " + tx.hash);
      await tx.wait();
      setStatus("Test Mode ✅ (lock 5 นาที / period 1 นาที)");
      await refreshAll();
    }catch(e){
      setStatus("Test Mode ไม่สำเร็จ: " + (e?.shortMessage||e?.message||e));
    }
  }

  async function onProdMode(){
    try{
      if(!isOwner) return setStatus("คุณไม่ใช่ Owner");
      // lock=365d, period=30d, bps=1000
      const tx = await stake.setParams(
        1000000000000000000n,
        1000000000000000000000n,
        10000000000000000000n,
        31536000n,
        2592000n,
        1000n
      );
      setStatus("กำลังตั้ง Prod Mode... " + tx.hash);
      await tx.wait();
      setStatus("Prod Mode ✅ (365d / 30d / 10%)");
      await refreshAll();
    }catch(e){
      setStatus("Prod Mode ไม่สำเร็จ: " + (e?.shortMessage||e?.message||e));
    }
  }

  async function onWithdrawToken(){
    try{
      if(!isOwner) return setStatus("คุณไม่ใช่ Owner");
      const token = ($("wToken").value||"").trim();
      if(!token) throw new Error("กรุณาใส่ token address");
      const amt = toBN($("wAmt").value);

      const tx = await stake.ownerWithdrawToken(token, amt);
      setStatus("กำลัง Withdraw Token... " + tx.hash);
      await tx.wait();
      setStatus("Withdraw Token สำเร็จ ✅");
      await refreshAll();
    }catch(e){
      setStatus("Withdraw Token ไม่สำเร็จ: " + (e?.shortMessage||e?.message||e));
    }
  }

  function fillToken(addr){
    $("wToken").value = addr;
  }

  window.addEventListener("load", ()=>{
    $("btnConnect").onclick = connect;
    $("btnRefresh").onclick = onRefresh;

    $("btnSetParams").onclick = onSetParams;
    $("btnTestMode").onclick = onTestMode;
    $("btnProdMode").onclick = onProdMode;

    $("btnWithdrawToken").onclick = onWithdrawToken;

    $("btnFillUSDT").onclick = ()=>fillToken(C.USDT);
    $("btnFillSTCEx").onclick = ()=>fillToken(C.STCEX);
    $("btnFillSTC").onclick = ()=>fillToken(C.STC);

    // init static
    $("contract").textContent = C.CONTRACT;
    $("addrUSDT").textContent = C.USDT;
    $("addrSTCEx").textContent = C.STCEX;
    $("addrSTC").textContent = C.STC;
  });
})();

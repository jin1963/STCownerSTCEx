(() => {
  "use strict";
  const C = window.APP_CONFIG;
  if (!C) throw new Error("Missing config.js (window.APP_CONFIG)");

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const setStatus = (t) => { $("status").textContent = t; };

  // ---------- ABIs ----------
  const ERC20_ABI = [
    "function decimals() view returns(uint8)",
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address owner,address spender) view returns(uint256)",
    "function approve(address spender,uint256) returns(bool)",
  ];

  // ✅ ตรงกับ ABI ที่คุณส่งมา
  const STAKE_ABI = [
    "function owner() view returns(address)",
    "function stcexPerUsdt() view returns(uint256)",
    "function stcPerStcex() view returns(uint256)",
    "function minStakeSTCEx() view returns(uint256)",
    "function lockSeconds() view returns(uint256)",
    "function periodSeconds() view returns(uint256)",
    "function rewardBps() view returns(uint256)",

    "function swapUSDTToSTCEx(uint256 usdtAmount)",
    "function stakeWithSTCEx(uint256 stcexAmount)",

    "function positionsCount(address user) view returns(uint256)",
    "function getPosition(address user,uint256 posId) view returns(uint256 principalSTC,uint256 startTime,bool withdrawn)",
    "function accruedRewardSTC(address user,uint256 posId) view returns(uint256 reward,uint256 periods)",
    "function timeUntilUnlock(address user,uint256 posId) view returns(uint256)",
    "function unlockAt(address user,uint256 posId) view returns(uint256)",
    "function matured(address user,uint256 posId) view returns(bool)",

    "function withdrawPosition(uint256 posId)",
  ];

  // ---------- State ----------
  let provider, signer, user;
  let usdt, stcex, stc, stake;
  let decUSDT = 18, decSTCEx = 18, decSTC = 18;
  let tickTimer = null;

  // ---------- Utils ----------
  function fmtUnits(v, dec, p = 6) {
    try {
      const s = ethers.formatUnits(v, dec);
      const n = Number(s);
      if (!isFinite(n)) return s;
      return n.toLocaleString(undefined, { maximumFractionDigits: p });
    } catch { return "-"; }
  }
  function parseUnitsSafe(str, dec) {
    const s = (str || "").trim();
    if (!s) throw new Error("กรุณากรอกจำนวน");
    return ethers.parseUnits(s, dec);
  }
  function fmtDuration(sec) {
    sec = Number(sec || 0);
    if (sec <= 0) return "00:00:00";
    const d = Math.floor(sec / 86400); sec -= d * 86400;
    const h = Math.floor(sec / 3600);  sec -= h * 3600;
    const m = Math.floor(sec / 60);    sec -= m * 60;
    const pad = (x) => String(x).padStart(2, "0");
    return (d > 0 ? `${d}d ` : "") + `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
  function fmtDateFromUnix(ts) {
    try {
      if (!ts || ts === 0n) return "-";
      return new Date(Number(ts) * 1000).toLocaleString();
    } catch { return "-"; }
  }

  async function ensureBSC() {
    if (!window.ethereum) throw new Error("ไม่พบ Wallet (MetaMask/Bitget)");
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId !== C.CHAIN_ID_HEX) {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: C.CHAIN_ID_HEX }],
      });
    }
  }

  async function approveToken(token, amountWei) {
    const a = await token.allowance(user, C.CONTRACT);
    if (a >= amountWei) return;
    const tx = await token.approve(C.CONTRACT, amountWei);
    setStatus("กำลัง Approve... " + tx.hash);
    await tx.wait();
    setStatus("Approve สำเร็จ ✅");
  }

  // ---------- Refresh ----------
  async function refreshHeader() {
    $("contract").textContent = C.CONTRACT;
    $("scanContract").href = `${C.EXPLORER}/address/${C.CONTRACT}`;
    if (user) $("scanWallet").href = `${C.EXPLORER}/address/${user}`;

    const net = await provider.getNetwork();
    $("net").textContent = `${net.name || C.CHAIN_NAME} (${Number(net.chainId)})`;

    const [own, r1, r2, minS, lockS, perS, bps] = await Promise.all([
      stake.owner(),
      stake.stcexPerUsdt(),
      stake.stcPerStcex(),
      stake.minStakeSTCEx(),
      stake.lockSeconds(),
      stake.periodSeconds(),
      stake.rewardBps(),
    ]);

    $("owner").textContent = own;
    $("rate1").textContent = r1.toString();
    $("rate2").textContent = r2.toString();
    $("minStake").textContent = fmtUnits(minS, decSTCEx, 6);

    $("lock").textContent = `${Number(lockS)} sec`;
    $("period").textContent = `${Number(perS)} sec`;
    $("bps").textContent = bps.toString();
  }

  async function refreshBalances() {
    const [bU, bE, bS] = await Promise.all([
      usdt.balanceOf(user),
      stcex.balanceOf(user),
      stc.balanceOf(user),
    ]);
    $("balUSDT").textContent = fmtUnits(bU, decUSDT);
    $("balSTCEx").textContent = fmtUnits(bE, decSTCEx);
    $("balSTC").textContent = fmtUnits(bS, decSTC);
  }

  async function renderPositions() {
    const cnt = Number(await stake.positionsCount(user));
    $("posCount").textContent = String(cnt);

    const body = $("posBody");
    body.innerHTML = "";
    if (cnt === 0) {
      body.innerHTML = `<tr><td colspan="6" class="muted">ยังไม่มีก้อน</td></tr>`;
      return;
    }

    for (let i = 0; i < cnt; i++) {
      const [pos, acc, tUnlock, ua, isMat] = await Promise.all([
        stake.getPosition(user, i),
        stake.accruedRewardSTC(user, i),
        stake.timeUntilUnlock(user, i),
        stake.unlockAt(user, i),
        stake.matured(user, i),
      ]);

      const principal = pos[0];
      const withdrawn = pos[2];

      const reward = acc[0];
      const periods = acc[1];

      const statusTxt = withdrawn ? "✅ withdrawn" : (isMat ? "✅ matured" : "⏳ locked");
      const unlockTxt = withdrawn ? "-" : fmtDuration(tUnlock);
      const unlockAtTxt = withdrawn ? "-" : fmtDateFromUnix(ua);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${i}</td>
        <td class="mono">${fmtUnits(principal, decSTC)}</td>
        <td class="mono">${fmtUnits(reward, decSTC)} <span class="muted">(p:${periods})</span></td>
        <td class="mono">${unlockTxt}<div class="muted">${unlockAtTxt}</div></td>
        <td>${statusTxt}</td>
        <td><button data-w="${i}" ${(!isMat || withdrawn) ? "disabled" : ""}>Withdraw</button></td>
      `;
      body.appendChild(tr);
    }

    body.querySelectorAll("button[data-w]").forEach((btn) => {
      btn.onclick = async () => {
        const id = Number(btn.getAttribute("data-w"));
        try {
          const ok = await stake.matured(user, id);
          if (!ok) return setStatus("ยังไม่ครบสัญญา (ก้อนนี้ยังถอนไม่ได้)");
          const tx = await stake.withdrawPosition(id);
          setStatus(`กำลัง Withdraw pos#${id}... ${tx.hash}`);
          await tx.wait();
          setStatus(`Withdraw pos#${id} สำเร็จ ✅`);
          await refreshBalances();
          await renderPositions();
        } catch (e) {
          setStatus("Withdraw ไม่สำเร็จ: " + (e?.shortMessage || e?.message || e));
        }
      };
    });
  }

  async function connect() {
    try {
      await ensureBSC();
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
      user = await signer.getAddress();

      usdt = new ethers.Contract(C.USDT, ERC20_ABI, signer);
      stcex = new ethers.Contract(C.STCEX, ERC20_ABI, signer);
      stc = new ethers.Contract(C.STC, ERC20_ABI, signer);
      stake = new ethers.Contract(C.CONTRACT, STAKE_ABI, signer);

      decUSDT = await usdt.decimals();
      decSTCEx = await stcex.decimals();
      decSTC = await stc.decimals();

      $("wallet").textContent = user;
      $("scanWallet").href = `${C.EXPLORER}/address/${user}`;

      setStatus("เชื่อมต่อสำเร็จ ✅");

      await refreshHeader();
      await refreshBalances();
      await renderPositions();

      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(async () => {
        try { if (user) await renderPositions(); } catch {}
      }, 10000); // รีเฟรชตารางทุก 10 วิ
    } catch (e) {
      setStatus("เชื่อมต่อไม่สำเร็จ: " + (e?.shortMessage || e?.message || e));
    }
  }

  async function onApproveUSDT() {
    try {
      if (!user) return setStatus("กรุณาเชื่อมต่อกระเป๋าก่อน");
      const amt = parseUnitsSafe($("usdtIn").value, decUSDT);
      await approveToken(usdt, amt);
    } catch (e) {
      setStatus("Approve USDT ไม่สำเร็จ: " + (e?.shortMessage || e?.message || e));
    }
  }

  async function onSwap() {
    try {
      if (!user) return setStatus("กรุณาเชื่อมต่อกระเป๋าก่อน");
      const amt = parseUnitsSafe($("usdtIn").value, decUSDT);
      await approveToken(usdt, amt);
      const tx = await stake.swapUSDTToSTCEx(amt);
      setStatus("กำลัง Swap... " + tx.hash);
      await tx.wait();
      setStatus("Swap สำเร็จ ✅");
      await refreshBalances();
    } catch (e) {
      setStatus("Swap ไม่สำเร็จ: " + (e?.shortMessage || e?.message || e));
    }
  }

  async function onApproveSTCEx() {
    try {
      if (!user) return setStatus("กรุณาเชื่อมต่อกระเป๋าก่อน");
      const amt = parseUnitsSafe($("stcexIn").value, decSTCEx);
      await approveToken(stcex, amt);
    } catch (e) {
      setStatus("Approve STCEx ไม่สำเร็จ: " + (e?.shortMessage || e?.message || e));
    }
  }

  async function onStake() {
    try {
      if (!user) return setStatus("กรุณาเชื่อมต่อกระเป๋าก่อน");
      const amt = parseUnitsSafe($("stcexIn").value, decSTCEx);
      await approveToken(stcex, amt);
      const tx = await stake.stakeWithSTCEx(amt);
      setStatus("กำลัง Stake (สร้างก้อน)... " + tx.hash);
      await tx.wait();
      setStatus("Stake สำเร็จ ✅ (สร้างก้อนใหม่แล้ว)");
      await refreshBalances();
      await renderPositions();
    } catch (e) {
      setStatus("Stake ไม่สำเร็จ: " + (e?.shortMessage || e?.message || e));
    }
  }

  async function onRefresh() {
    try {
      if (!user) return setStatus("กรุณาเชื่อมต่อกระเป๋าก่อน");
      await refreshHeader();
      await refreshBalances();
      await renderPositions();
      setStatus("อัปเดตแล้ว ✅");
    } catch (e) {
      setStatus("Refresh ไม่สำเร็จ: " + (e?.shortMessage || e?.message || e));
    }
  }

  window.addEventListener("load", () => {
    $("btnConnect").onclick = connect;
    $("btnApproveUSDT").onclick = onApproveUSDT;
    $("btnSwap").onclick = onSwap;
    $("btnApproveSTCEx").onclick = onApproveSTCEx;
    $("btnStake").onclick = onStake;
    $("btnRefresh").onclick = onRefresh;

    // fill contract link even before connect
    $("contract").textContent = C.CONTRACT;
    $("scanContract").href = `${C.EXPLORER}/address/${C.CONTRACT}`;
  });
})();

import { Activity, ArrowUpRight, BadgeCheck, Check, Clock3, Fingerprint, Plus, Radio, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WalletSession } from "./wallet";
import { compact, explorerTransaction } from "./evidence";
import {
  createSandboxRound,
  listSandboxRounds,
  reclaimSandboxBid,
  settleSandboxRound,
  submitSandboxBid,
  type SandboxRound,
} from "./sandbox";

type ActionState =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "success"; label: string; hash?: string }
  | { status: "error"; label: string };

export function LiveSandboxPage({ session, onConnect }: {
  session?: WalletSession;
  onConnect: () => void;
}) {
  const [rounds, setRounds] = useState<SandboxRound[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>({ status: "idle" });
  const [bid, setBid] = useState("12");

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      setRounds(await listSandboxRounds());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Live sandbox unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const round = rounds[0];
  const isIssuer = Boolean(session && round?.issuer === session.address);
  const hasBid = Boolean(session && round?.bidders.includes(session.address));
  const settled = Boolean(round?.winner);
  const receipts = useMemo(() => round ? Object.entries(round.receipts).filter(([, hash]) => /^[0-9a-f]{64}$/i.test(hash)) : [], [round]);

  const createRound = async () => {
    if (!session) return onConnect();
    setAction({ status: "loading", label: "Preparing controller and confidential account" });
    try {
      const created = await createSandboxRound(session);
      setRounds((current) => [created, ...current.filter((item) => item.roundId !== created.roundId)]);
      setAction({ status: "success", label: "Live round opened", hash: created.receipts.openRound });
    } catch (error) {
      setAction({ status: "error", label: error instanceof Error ? error.message : "Round creation failed" });
    }
  };

  const placeBid = async () => {
    if (!session) return onConnect();
    if (!round) return;
    setAction({ status: "loading", label: "Generating confidential bid proof in this browser" });
    try {
      const result = await submitSandboxBid(session, round, BigInt(Math.round(Number(bid) * 10_000_000)));
      setAction({ status: "success", label: "Sealed bid confirmed", hash: result.registrationTransaction });
      await refresh();
    } catch (error) {
      setAction({ status: "error", label: error instanceof Error ? error.message : "Bid failed" });
    }
  };

  const settle = async () => {
    if (!round) return;
    setAction({ status: "loading", label: "Closing book and generating maximum-bid proof" });
    try {
      const result = await settleSandboxRound(round.roundId);
      setRounds((current) => [result, ...current.filter((item) => item.roundId !== result.roundId)]);
      setAction({ status: "success", label: "Round settled atomically", hash: result.receipts.finalize });
    } catch (error) {
      setAction({ status: "error", label: error instanceof Error ? error.message : "Settlement failed" });
    }
  };

  const reclaim = async () => {
    if (!round || !session) return;
    setAction({ status: "loading", label: "Generating reclaim proof in this browser" });
    try {
      const result = await reclaimSandboxBid(session, round);
      setAction({ status: "success", label: "Losing bid reclaimed", hash: result.transaction });
    } catch (error) {
      setAction({ status: "error", label: error instanceof Error ? error.message : "Reclaim failed" });
    }
  };

  if (loading) {
    return <div className="workspace-page live-loading"><Activity className="spin" size={20}/> Reading live sandbox</div>;
  }

  return (
    <div className="workspace-page page-enter">
      <div className="page-title-row live-title-row">
        <div><span className="section-kicker">MULTI-WALLET TESTNET SANDBOX</span><h1>Live issuance</h1><p>New wallet signatures, new round receipts and a new settlement proof.</p></div>
        <button type="button" className="icon-pressable" onClick={() => void refresh()} aria-label="Refresh live round"><RefreshCw size={17}/></button>
      </div>

      {loadError && <div className="live-alert error"><Radio size={16}/><span><strong>Sandbox service unavailable</strong>{loadError}</span></div>}

      {!round ? (
        <section className="live-empty">
          <span className="live-empty-icon"><Plus size={26}/></span>
          <div><span className="section-kicker">NO ACTIVE SANDBOX ROUND</span><h2>Open the next issuance</h2><p>The connected account becomes the issuer and signs every market transaction.</p></div>
          <button type="button" className="pressable button-primary button-large" onClick={() => void createRound()} disabled={action.status === "loading"}>
            {action.status === "loading" ? <Activity className="spin" size={17}/> : session ? <Plus size={17}/> : <Wallet size={17}/>} {session ? "Create live round" : "Connect issuer wallet"}
          </button>
        </section>
      ) : (
        <>
          <section className="live-round-band">
            <div className="live-round-identity"><span className="section-kicker">CURRENT ROUND</span><h1>QB / {compact(round.roundId, 6, 4)}</h1><code>{round.roundId}</code></div>
            <div className="live-round-metrics">
              <div><span>Status</span><strong>{settled ? "Settled" : "Open"}</strong></div>
              <div><span>Book</span><strong>{round.bidders.length} / 3 wallets</strong></div>
              <div><span>Bid values</span><strong>Hidden</strong></div>
            </div>
          </section>

          <div className="live-action-layout">
            <section className="live-primary-action">
              <div className="live-role-line"><span>{isIssuer ? <ShieldCheck size={17}/> : <Wallet size={17}/>} {isIssuer ? "ISSUER WALLET" : "INVESTOR WALLET"}</span><b>{session ? compact(session.address) : "Not connected"}</b></div>
              {!session && <><h2>Connect a Testnet wallet</h2><p>Freighter signs the actions for this account.</p><button type="button" className="pressable button-primary" onClick={onConnect}><Wallet size={16}/> Connect wallet</button></>}
              {session && isIssuer && !settled && <><h2>{round.bidders.length < 3 ? "Collecting sealed bids" : "Book is ready"}</h2><p>{round.bidders.length < 3 ? `${3 - round.bidders.length} investor wallet${3 - round.bidders.length === 1 ? "" : "s"} remaining.` : "Close after the on-chain deadline and settle the proven winner."}</p><button type="button" className="pressable button-primary" onClick={() => void settle()} disabled={action.status === "loading" || round.bidders.length === 0}>{action.status === "loading" ? <Activity className="spin" size={16}/> : <Fingerprint size={16}/>} Close & settle round</button></>}
              {session && !isIssuer && !settled && !hasBid && <><h2>Submit one confidential bid</h2><div className="bid-field"><label htmlFor="live-bid">YOUR BID</label><span><input id="live-bid" inputMode="decimal" value={bid} onChange={(event) => setBid(event.target.value.replace(/[^0-9.]/g, ""))}/><b>XLM</b></span><small>8.00 minimum · 20.00 maximum</small></div><button type="button" className="pressable button-primary button-large" onClick={() => void placeBid()} disabled={action.status === "loading"}>{action.status === "loading" ? <Activity className="spin" size={17}/> : <Fingerprint size={17}/>} Prove & sign sealed bid</button></>}
              {session && !isIssuer && hasBid && !settled && <div className="live-complete"><BadgeCheck size={28}/><h2>Bid sealed on Testnet</h2><p>Your value stays in this browser and the operator’s private settlement vault.</p></div>}
              {settled && <div className="live-complete"><BadgeCheck size={28}/><h2>{session?.address === round.winner ? "Your bid won" : "Round settled"}</h2><p>The proof and atomic settlement receipt are available in the live evidence stream.</p>{session && hasBid && session.address !== round.winner && <button type="button" className="pressable button-primary" onClick={() => void reclaim()} disabled={action.status === "loading"}>{action.status === "loading" ? <Activity className="spin" size={16}/> : <Wallet size={16}/>} Reclaim bid</button>}{session && !hasBid && <button type="button" className="pressable button-secondary" onClick={() => void createRound()} disabled={action.status === "loading"}><Plus size={16}/> Create next round</button>}</div>}
            </section>

            <section className="live-book">
              <div className="live-book-head"><span>PARTICIPANTS</span><b>{round.bidders.length}/3</b></div>
              {[0, 1, 2].map((index) => {
                const account = round.bidders[index];
                return <div className={`live-bidder ${account ? "filled" : ""}`} key={index}><span>{account ? <Check size={14}/> : index + 1}</span><div><strong>{account ? account === session?.address ? "Your wallet" : `Investor ${String(index + 1).padStart(2, "0")}` : "Available"}</strong><small>{account ? compact(account) : "Waiting for wallet"}</small></div><b>{account ? "SEALED" : "OPEN"}</b></div>;
              })}
              <div className="live-deadline"><Clock3 size={15}/><span>Close ledger<strong>{round.bidDeadlineLedger.toLocaleString()}</strong></span></div>
            </section>
          </div>

          {receipts.length > 0 && <section className="live-receipts"><div className="live-book-head"><span>LIVE EVIDENCE</span><b>{receipts.length} RECEIPTS</b></div>{receipts.slice(-6).reverse().map(([label, hash]) => <a key={`${label}:${hash}`} href={explorerTransaction(hash)} target="_blank" rel="noreferrer"><span><BadgeCheck size={15}/><b>{label.replace(/([A-Z])/g, " $1")}</b></span><code>{compact(hash, 12, 8)}</code><ArrowUpRight size={15}/></a>)}</section>}
        </>
      )}

      {action.status !== "idle" && <div className={`live-alert ${action.status}`} role="status">{action.status === "loading" ? <Activity className="spin" size={16}/> : action.status === "success" ? <BadgeCheck size={16}/> : <Radio size={16}/>}<span><strong>{action.status === "loading" ? "Wallet flow active" : action.status === "success" ? "Confirmed" : "Action stopped"}</strong>{action.label}</span>{action.status === "success" && action.hash && <a href={explorerTransaction(action.hash)} target="_blank" rel="noreferrer">Receipt <ArrowUpRight size={13}/></a>}</div>}
    </div>
  );
}

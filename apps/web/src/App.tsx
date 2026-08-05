import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Ban,
  BookOpen,
  Check,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileCheck2,
  Fingerprint,
  KeyRound,
  Landmark,
  Layers3,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  LogOut,
  Menu,
  Play,
  Radio,
  ReceiptText,
  RefreshCw,
  Scale,
  ScanEye,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MarketCanvas } from "./MarketCanvas";
import {
  compact,
  explorerTransaction,
  participants,
  testnetEvidence,
} from "./evidence";
import type { LiveSnapshot } from "./live";
import type { WalletSession } from "./wallet";

type AppMode = "landing" | "intro" | "console";
type Workspace = "overview" | "portfolio" | "audit" | "evidence";
type Perspective = "public" | "issuer" | "investor" | "auditor";
type WalletState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; session: WalletSession; roundStatus: string }
  | { status: "error"; message: string };
type LiveState =
  | { status: "checking" }
  | { status: "verified" | "mismatch"; snapshot: LiveSnapshot }
  | { status: "fallback"; error: string };
type AsyncState =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "success"; label: string; hash?: string }
  | { status: "error"; label: string; code: string };
type DemoState = {
  open: boolean;
  running: boolean;
  active: number;
  verified: number[];
  error?: string;
};

type IconType = typeof Eye;

const introSlides: Array<{
  kicker: string;
  title: string;
  copy: string;
  phase: "bidding" | "proof" | "settlement";
  stat: string;
  label: string;
}> = [
  {
    kicker: "01 / PRIVATE PRICE DISCOVERY",
    title: "The market sees participation. Not the demand curve.",
    copy: "Verified investors compete for one fixed issuance lot while bid values stay inside confidential commitments.",
    phase: "bidding",
    stat: "3",
    label: "sealed bid receipts",
  },
  {
    kicker: "02 / VERIFIABLE ALLOCATION",
    title: "The winner is proven against the complete book.",
    copy: "One UltraHonk statement binds bidder order, live delegations, reserve and the exact settlement payment.",
    phase: "proof",
    stat: "14,592 B",
    label: "maximum-bid proof",
  },
  {
    kicker: "03 / ATOMIC DELIVERY",
    title: "Confidential payment. Public delivery. One invocation.",
    copy: "The winning payment and escrowed RWA lot move together, with auditor and disclosure evidence attached.",
    phase: "settlement",
    stat: "1 tx",
    label: "atomic settlement",
  },
];

const workspaceItems: Array<{ id: Workspace; label: string; icon: IconType }> = [
  { id: "overview", label: "Market", icon: LayoutDashboard },
  { id: "portfolio", label: "My wallet", icon: CircleUserRound },
  { id: "audit", label: "Audit", icon: ScanEye },
  { id: "evidence", label: "Evidence", icon: Database },
];

const demoSteps: Array<{
  label: string;
  detail: string;
  icon: IconType;
  receipt?: string;
  negative?: boolean;
}> = [
  {
    label: "Lot escrowed",
    detail: "Fixed QBNOTE lot funded before opening",
    icon: Landmark,
    receipt: testnetEvidence.setup.roundTransactions.fundRound,
  },
  {
    label: "Book opened",
    detail: "Terms locked and controller bound",
    icon: BookOpen,
    receipt: testnetEvidence.setup.roundTransactions.openRound,
  },
  {
    label: "Three bids sealed",
    detail: "Round-scoped delegations registered",
    icon: LockKeyhole,
    receipt: testnetEvidence.setup.bidderTransactions[0]?.registerBid,
  },
  {
    label: "Policy denial",
    detail: "Unknown investor rejected on-chain",
    icon: Ban,
    negative: true,
  },
  {
    label: "Book frozen",
    detail: "Complete participant set committed",
    icon: Layers3,
    receipt: testnetEvidence.settlement.closeTransaction,
  },
  {
    label: "Winner proven",
    detail: "Maximum-bid statement matched",
    icon: Fingerprint,
    receipt: testnetEvidence.settlement.finalizeTransaction,
  },
  {
    label: "Settled atomically",
    detail: "Payment and RWA delivery confirmed",
    icon: Scale,
    receipt: testnetEvidence.settlement.finalizeTransaction,
  },
  {
    label: "Disclosure verified",
    detail: "Recipient and event binding matched",
    icon: FileCheck2,
  },
];

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function walletRole(wallet: WalletState) {
  if (wallet.status !== "connected") return "Guest";
  const address = wallet.session.address;
  if (address === testnetEvidence.deployment.roles.issuer) return "Issuer";
  if (address === testnetEvidence.deployment.roles.auditor) return "Auditor";
  if (participants.some((participant) => participant.account === address)) return "Investor";
  return "Observer";
}

function Pressable({
  children,
  className = "",
  onClick,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return <button type={type} className={`pressable ${className}`} onClick={onClick} disabled={disabled}>{children}</button>;
}

function WalletButton({ wallet, onConnect, onDisconnect }: {
  wallet: WalletState;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connected = wallet.status === "connected";
  return (
    <Pressable
      className={`wallet-button ${connected ? "connected" : ""}`}
      onClick={connected ? onDisconnect : onConnect}
      disabled={wallet.status === "connecting"}
    >
      {connected ? <LogOut size={15}/> : <Wallet size={15}/>}
      <span>{connected ? compact(wallet.session.address, 5, 4) : wallet.status === "connecting" ? "Connecting" : "Connect wallet"}</span>
    </Pressable>
  );
}

function Brand({ compactBrand = false }: { compactBrand?: boolean }) {
  return (
    <div className={`brand ${compactBrand ? "compact" : ""}`}>
      <span className="brand-symbol"><img src="/quietbook-logo.jpg" alt="" /></span>
      <span><strong>QuietBook</strong>{!compactBrand && <small>Primary issuance</small>}</span>
    </div>
  );
}

function PublicHeader({ wallet, onConnect, onDisconnect, onOpenConsole }: {
  wallet: WalletState;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenConsole: () => void;
}) {
  return (
    <header className="public-header">
      <Brand/>
      <div className="public-header-actions">
        <span className="testnet-badge"><Radio size={13}/> Stellar Testnet</span>
        <Pressable className="header-console-link" onClick={onOpenConsole}>Console <ArrowRight size={14}/></Pressable>
        <WalletButton wallet={wallet} onConnect={onConnect} onDisconnect={onDisconnect}/>
      </div>
    </header>
  );
}

function LivePill({ live }: { live: LiveState }) {
  const verified = live.status === "verified";
  return (
    <span className={`live-pill ${live.status}`}>
      {live.status === "checking" ? <Activity size={13}/> : verified ? <BadgeCheck size={13}/> : <Clock3 size={13}/>}
      {live.status === "checking" ? "Reading Testnet" : verified ? `Ledger ${live.snapshot.latestLedger.toLocaleString()}` : live.status === "mismatch" ? "State mismatch" : "Evidence fallback"}
    </span>
  );
}

function Landing({
  wallet,
  live,
  onConnect,
  onDisconnect,
  onIntro,
  onConsole,
}: {
  wallet: WalletState;
  live: LiveState;
  onConnect: () => void;
  onDisconnect: () => void;
  onIntro: () => void;
  onConsole: () => void;
}) {
  return (
    <div className="landing page-enter">
      <PublicHeader wallet={wallet} onConnect={onConnect} onDisconnect={onDisconnect} onOpenConsole={onConsole}/>
      <main>
        <section className="landing-hero">
          <MarketCanvas phase="bidding" className="hero-canvas"/>
          <div className="hero-copy">
            <div className="hero-kicker"><LivePill live={live}/><span>Confidential RWA issuance</span></div>
            <h1>QuietBook</h1>
            <p className="hero-tagline">Known investors. Private bids.<br/>Verifiable allocation.</p>
            <p className="hero-support">A fixed tokenized asset lot, a controlled investor set and a winner proven without publishing the demand curve.</p>
            <div className="hero-actions">
              <Pressable className="button-primary button-large" onClick={onIntro}><Play size={17}/> Run Testnet story</Pressable>
              <Pressable className="button-secondary button-large" onClick={onConsole}>Explore live round <ArrowRight size={17}/></Pressable>
            </div>
          </div>
          <div className="hero-ledger" aria-label="Current issuance summary">
            <span>LIVE ISSUANCE / QBNOTE-26</span>
            <strong>Settled</strong>
            <div><span>Verified investors</span><b>03</b></div>
            <div><span>Public bid values</span><b>Hidden</b></div>
            <div><span>Settlement</span><b>Atomic</b></div>
          </div>
        </section>
        <section className="landing-proof-band" aria-label="QuietBook guarantees">
          <div><LockKeyhole size={18}/><span><strong>Sealed institutional bids</strong><small>Commitments replace public amounts</small></span></div>
          <div><ShieldCheck size={18}/><span><strong>Policy-gated participation</strong><small>Known accounts, explicit eligibility</small></span></div>
          <div><Fingerprint size={18}/><span><strong>Auditable settlement</strong><small>Proof, receipts and controlled visibility</small></span></div>
        </section>
      </main>
    </div>
  );
}

function Intro({ step, onStep, onBack, onComplete }: {
  step: number;
  onStep: (step: number) => void;
  onBack: () => void;
  onComplete: () => void;
}) {
  const slide = introSlides[step]!;
  return (
    <div className="intro page-enter">
      <header className="intro-header">
        <Brand/>
        <div className="intro-progress" aria-label={`Introduction step ${step + 1} of ${introSlides.length}`}>
          {introSlides.map((item, index) => <span key={item.kicker} className={index <= step ? "complete" : ""}/>) }
        </div>
        <Pressable className="icon-pressable" onClick={onBack}><X size={19}/><span className="sr-only">Close introduction</span></Pressable>
      </header>
      <main className="intro-stage" key={slide.kicker}>
        <MarketCanvas phase={slide.phase} className="intro-canvas"/>
        <div className="intro-copy">
          <span className="section-kicker">{slide.kicker}</span>
          <h1>{slide.title}</h1>
          <p>{slide.copy}</p>
        </div>
        <div className="intro-stat"><strong>{slide.stat}</strong><span>{slide.label}</span></div>
        <div className="intro-controls">
          <Pressable className="intro-back" onClick={() => onStep(Math.max(0, step - 1))} disabled={step === 0}><ArrowLeft size={16}/> Back</Pressable>
          {step < introSlides.length - 1
            ? <Pressable className="button-primary button-large" onClick={() => onStep(step + 1)}>Continue <ArrowRight size={17}/></Pressable>
            : <Pressable className="button-primary button-large" onClick={onComplete}>Enter verified run <ArrowRight size={17}/></Pressable>}
        </div>
      </main>
    </div>
  );
}

function ConsoleHeader({
  workspace,
  wallet,
  live,
  onConnect,
  onDisconnect,
  onMenu,
}: {
  workspace: Workspace;
  wallet: WalletState;
  live: LiveState;
  onConnect: () => void;
  onDisconnect: () => void;
  onMenu: () => void;
}) {
  return (
    <header className="console-header">
      <Pressable className="mobile-menu icon-pressable" onClick={onMenu}><Menu size={19}/><span className="sr-only">Open navigation</span></Pressable>
      <div className="console-title"><span>Workspace</span><strong>{workspaceItems.find((item) => item.id === workspace)?.label}</strong></div>
      <div className="console-header-actions"><LivePill live={live}/><WalletButton wallet={wallet} onConnect={onConnect} onDisconnect={onDisconnect}/></div>
    </header>
  );
}

function Sidebar({ workspace, open, onSelect, onClose }: {
  workspace: Workspace;
  open: boolean;
  onSelect: (workspace: Workspace) => void;
  onClose: () => void;
}) {
  return (
    <>
      <button className={`sidebar-scrim ${open ? "open" : ""}`} aria-label="Close navigation" onClick={onClose}/>
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <Brand/>
        <nav aria-label="Workspace navigation">
          <span className="nav-label">WORKSPACE</span>
          {workspaceItems.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={workspace === id ? "active" : ""} onClick={() => { onSelect(id); onClose(); }}>
              <Icon size={17}/><span>{label}</span>{workspace === id && <ChevronRight size={14}/>}
            </button>
          ))}
        </nav>
        <div className="sidebar-network"><span><Radio size={13}/> TESTNET</span><strong>Unaudited prototype</strong><small>No mainnet or production value</small></div>
      </aside>
    </>
  );
}

function SectionHeading({ kicker, title, action }: { kicker: string; title: string; action?: ReactNode }) {
  return <div className="section-heading"><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div>{action}</div>;
}

function StatusTag({ children, tone = "green" }: { children: ReactNode; tone?: "green" | "coral" | "ink" | "muted" }) {
  return <span className={`status-tag ${tone}`}>{children}</span>;
}

function AccountAction({
  wallet,
  role,
  eligibility,
  onConnect,
  onEligibility,
  onRunDemo,
}: {
  wallet: WalletState;
  role: string;
  eligibility: AsyncState;
  onConnect: () => void;
  onEligibility: () => void;
  onRunDemo: () => void;
}) {
  const connected = wallet.status === "connected";
  return (
    <section className="account-action">
      <div className="account-action-top">
        <span className="account-icon"><Wallet size={18}/></span>
        <div><span>CONNECTED CONTEXT</span><strong>{connected ? role : "No wallet connected"}</strong></div>
        {connected && <StatusTag>{wallet.session.network}</StatusTag>}
      </div>
      {connected ? (
        <>
          <code>{wallet.session.address}</code>
          <div className="account-state-row"><span>Fixture round</span><strong>{wallet.roundStatus}</strong></div>
          <div className="account-state-row"><span>Write availability</span><strong>{wallet.roundStatus === "Settled" ? "Archived" : "Review"}</strong></div>
          {eligibility.status === "success" && <div className="inline-result success"><Check size={15}/>{eligibility.label}</div>}
          {eligibility.status === "error" && <div className="inline-result denied"><Ban size={15}/><span><strong>{eligibility.label}</strong><small>{eligibility.code}</small></span></div>}
          <Pressable className="button-secondary button-full" onClick={onEligibility} disabled={eligibility.status === "loading"}>
            {eligibility.status === "loading" ? <Activity className="spin" size={16}/> : <ShieldCheck size={16}/>} {eligibility.status === "loading" ? eligibility.label : "Check policy access"}
          </Pressable>
        </>
      ) : (
        <>
          <p>Wallet context unlocks account-bound policy and lifecycle state. The verified story remains wallet-free.</p>
          <Pressable className="button-primary button-full" onClick={onConnect}><Wallet size={16}/> Connect Freighter</Pressable>
        </>
      )}
      <Pressable className="text-action" onClick={onRunDemo}><Play size={14}/> Run wallet-free Testnet story</Pressable>
    </section>
  );
}

function PerspectivePanel({ perspective, wallet, onRunDemo, onEligibility }: {
  perspective: Perspective;
  wallet: WalletState;
  onRunDemo: () => void;
  onEligibility: () => void;
}) {
  const connected = wallet.status === "connected";
  const winner = participants.find((participant) => participant.winner)!;
  const rows = perspective === "public"
    ? [
        ["Bid receipts", "3 confirmed", "good"],
        ["Bid values", "Hidden", "hidden"],
        ["Winner", winner.alias, "good"],
        ["Settlement", "Complete", "good"],
      ]
    : perspective === "issuer"
      ? [
          ["Terms", "Immutable", "good"],
          ["RWA escrow", "Delivered", "good"],
          ["Payment amount", "Confidential", "hidden"],
          ["Final receipt", compact(testnetEvidence.settlement.finalizeTransaction), "neutral"],
        ]
      : perspective === "investor"
        ? [
            ["Account", connected ? compact(wallet.session.address, 7, 5) : "Not connected", "neutral"],
            ["Eligibility", connected ? "Check live policy" : "Account-bound", "neutral"],
            ["Competing bids", "Not visible", "hidden"],
            ["Fixture result", connected && wallet.session.address === winner.account ? "Won" : "Private", "neutral"],
          ]
        : [
            ["Key version", String(testnetEvidence.audit.auditor.keyVersion), "good"],
            ["Linked events", String(testnetEvidence.audit.eventVerification.indexedEvents), "good"],
            ["Decrypted values", "Local vault only", "hidden"],
            ["Signed export", "Verified", "good"],
          ];
  return (
    <div className="perspective-panel panel-enter" key={perspective}>
      <div className="perspective-banner">
        <span>{perspective.toUpperCase()} VIEW</span>
        <StatusTag tone={perspective === "public" ? "muted" : "ink"}>{perspective === "public" ? "No wallet required" : "Role scoped"}</StatusTag>
      </div>
      <div className="perspective-rows">
        {rows.map(([label, value, tone]) => (
          <div key={label}><span>{label}</span><strong className={tone}>{tone === "hidden" && <EyeOff size={14}/>} {tone === "good" && <Check size={14}/>} {value}</strong></div>
        ))}
      </div>
      <Pressable className="button-secondary button-full" onClick={perspective === "investor" && connected ? onEligibility : onRunDemo}>
        {perspective === "investor" && connected ? <ShieldCheck size={15}/> : <Play size={15}/>}
        {perspective === "investor" && connected ? "Check live eligibility" : "Verify this view"}
      </Pressable>
    </div>
  );
}

function RoundTimeline({ onRunDemo }: { onRunDemo: () => void }) {
  return (
    <section className="timeline-section">
      <SectionHeading kicker="CANONICAL FLOW" title="From escrow to controlled disclosure" action={<Pressable className="button-secondary" onClick={onRunDemo}><Play size={15}/> Replay receipts</Pressable>}/>
      <div className="round-timeline">
        {demoSteps.map(({ label, icon: Icon, negative }, index) => (
          <div key={label} className={negative ? "negative" : ""}>
            <span className="timeline-node">{negative ? <Ban size={15}/> : <Check size={15}/>}</span>
            <small>{String(index + 1).padStart(2, "0")}</small>
            <strong>{label}</strong>
            <Icon size={16}/>
          </div>
        ))}
      </div>
    </section>
  );
}

function WalletActionPanel({
  wallet,
  role,
  eligibility,
  lifecycle,
  onConnect,
  onEligibility,
  onCloseLifecycle,
}: {
  wallet: WalletState;
  role: string;
  eligibility: AsyncState;
  lifecycle: AsyncState;
  onConnect: () => void;
  onEligibility: () => void;
  onCloseLifecycle: () => void;
}) {
  const connected = wallet.status === "connected";
  const policyChecked = eligibility.status === "success" || eligibility.status === "error";
  return (
    <section className="wallet-flow">
      <div className="wallet-flow-head">
        <span className="account-icon"><Wallet size={18}/></span>
        <div><span>YOUR WALLET</span><h2>{connected ? role : "Start here"}</h2></div>
        {connected && <StatusTag>{wallet.session.network}</StatusTag>}
      </div>
      {connected && <code>{wallet.session.address}</code>}
      <div className="wallet-flow-steps">
        <div className={connected ? "complete" : "active"}><span>{connected ? <Check size={14}/> : "1"}</span><div><strong>Connect wallet</strong><small>{connected ? "Freighter connected" : "Stellar Testnet account"}</small></div></div>
        <div className={policyChecked ? "complete" : connected ? "active" : ""}><span>{policyChecked ? <Check size={14}/> : "2"}</span><div><strong>Check access</strong><small>{policyChecked ? eligibility.label : "Read the on-chain policy"}</small></div></div>
        <div className={lifecycle.status === "success" ? "complete" : policyChecked ? "active" : ""}><span>{lifecycle.status === "success" ? <Check size={14}/> : "3"}</span><div><strong>Close bid window</strong><small>{lifecycle.status === "success" ? "Testnet receipt confirmed" : "Submit close_round with Freighter"}</small></div></div>
      </div>
      {!connected && <Pressable className="button-primary button-full" onClick={onConnect}><Wallet size={16}/> Connect Freighter</Pressable>}
      {connected && !policyChecked && <Pressable className="button-primary button-full" onClick={onEligibility} disabled={eligibility.status === "loading"}>{eligibility.status === "loading" ? <Activity className="spin" size={16}/> : <ShieldCheck size={16}/>} {eligibility.status === "loading" ? eligibility.label : "Check my access"}</Pressable>}
      {connected && policyChecked && lifecycle.status !== "success" && (
        <TransactionButton state={lifecycle} onClick={onCloseLifecycle}/>
      )}
      {connected && policyChecked && <div className="wallet-flow-note"><Clock3 size={15}/><span><strong>QBNOTE-26 is already settled.</strong> The available write closes the empty lifecycle fixture; no bid value is requested.</span></div>}
      {lifecycle.status === "success" && lifecycle.hash && <a className="receipt-link" href={explorerTransaction(lifecycle.hash)} target="_blank" rel="noreferrer"><ReceiptText size={15}/> View confirmed receipt <ArrowUpRight size={14}/></a>}
      {lifecycle.status === "error" && <div className="inline-result denied"><Ban size={15}/><span><strong>{lifecycle.label}</strong><small>{lifecycle.code}</small></span></div>}
    </section>
  );
}

function OverviewPage({
  wallet,
  live,
  role,
  eligibility,
  lifecycle,
  onConnect,
  onEligibility,
  onCloseLifecycle,
  onRunDemo,
  onEvidence,
}: {
  wallet: WalletState;
  live: LiveState;
  role: string;
  eligibility: AsyncState;
  lifecycle: AsyncState;
  onConnect: () => void;
  onEligibility: () => void;
  onCloseLifecycle: () => void;
  onRunDemo: () => void;
  onEvidence: () => void;
}) {
  return (
    <div className="workspace-page page-enter">
      <section className="workspace-hero">
        <div className="workspace-hero-copy">
          <span className="section-kicker">CURRENT ISSUANCE / SETTLED</span>
          <h1>QBNOTE-26</h1>
          <p>A fixed tokenized asset lot sold through three confidential offers. Connect your wallet for account-specific actions.</p>
          <div className="workspace-hero-actions">
            <Pressable className="button-primary" onClick={onRunDemo}><Play size={16}/> Verify completed round</Pressable>
            <Pressable className="button-secondary" onClick={onEvidence}>View receipts <ArrowRight size={15}/></Pressable>
          </div>
        </div>
        <div className="issuance-pulse">
          <div className="pulse-top"><span>QBNOTE-26</span><StatusTag>Settled</StatusTag></div>
          <strong>1.0000000 <small>QBNOTE</small></strong>
          <div className="pulse-line"><span>Public reserve</span><b>8.0000000 XLM</b></div>
          <div className="pulse-line"><span>Verified book</span><b>3 investors</b></div>
          <div className="pulse-line"><span>Bid values</span><b className="hidden"><EyeOff size={13}/> Hidden</b></div>
          <div className={`pulse-live ${live.status}`}><span/><b>{live.status === "verified" ? "Live state matched" : live.status === "checking" ? "Reading state" : "Recorded evidence active"}</b></div>
        </div>
      </section>

      <div className="overview-grid">
        <section className="round-summary">
          <SectionHeading kicker="ROUND SUMMARY" title="What happened" action={<StatusTag>Settled</StatusTag>}/>
          <div className="round-summary-rows">
            <div><span>RWA lot</span><strong>1.0000000 QBNOTE</strong></div>
            <div><span>Verified investors</span><strong>3 accounts</strong></div>
            <div><span>Bid values</span><strong className="hidden"><EyeOff size={14}/> Hidden</strong></div>
            <div><span>Winner</span><strong>{participants.find((item) => item.winner)?.alias}</strong></div>
            <div><span>Max-bid proof</span><strong><Check size={14}/> Verified</strong></div>
            <div><span>Settlement</span><strong><Check size={14}/> Atomic</strong></div>
          </div>
        </section>
        <WalletActionPanel wallet={wallet} role={role} eligibility={eligibility} lifecycle={lifecycle} onConnect={onConnect} onEligibility={onEligibility} onCloseLifecycle={onCloseLifecycle}/>
      </div>
    </div>
  );
}

function TransactionButton({ state, onClick, disabled }: { state: AsyncState; onClick: () => void; disabled?: boolean }) {
  return (
    <Pressable className="button-primary transaction-button" onClick={onClick} disabled={disabled || state.status === "loading" || state.status === "success"}>
      {state.status === "loading" ? <Activity className="spin" size={16}/> : state.status === "success" ? <Check size={16}/> : <Wallet size={16}/>}
      {state.status === "idle" ? "Close empty round on Testnet" : state.label}
    </Pressable>
  );
}

function IssuancesPage({ wallet, lifecycle, onCloseLifecycle, onRunDemo }: {
  wallet: WalletState;
  lifecycle: AsyncState;
  onCloseLifecycle: () => void;
  onRunDemo: () => void;
}) {
  return (
    <div className="workspace-page page-enter">
      <div className="page-title-row"><div><span className="section-kicker">ISSUANCE BOOK</span><h1>Rounds</h1><p>Immutable terms, public lifecycle, confidential offer values.</p></div><Pressable className="button-primary" onClick={onRunDemo}><Play size={16}/> Run guided issuance</Pressable></div>
      <section className="issuance-list">
        <article className="issuance-row featured">
          <div className="asset-monogram">QB</div>
          <div className="issuance-main"><span>DEMO FIXTURE / PRIMARY ISSUANCE</span><h2>QBNOTE-26</h2><p>Fixed RWA lot · 3 verified investors · first-price sealed bid</p></div>
          <div className="issuance-facts"><span>LOT<strong>1.0000000 QBNOTE</strong></span><span>BOOK<strong>3 sealed receipts</strong></span><span>RESULT<strong>Settled</strong></span></div>
          <a className="icon-link" href={testnetEvidence.settlement.explorer} target="_blank" rel="noreferrer" aria-label="Open final settlement"><ArrowUpRight size={18}/></a>
        </article>
        <article className="issuance-row lifecycle-row">
          <div className="asset-monogram muted">LX</div>
          <div className="issuance-main"><span>LIFECYCLE FIXTURE / WITHDRAWAL PATH</span><h2>Bid exit exercise</h2><p>Delegation revoked · bidder removed · zero active bids</p></div>
          <div className="issuance-facts"><span>ROUND<strong>{compact(testnetEvidence.withdrawal.roundId)}</strong></span><span>STATE<strong>{lifecycle.status === "success" ? "Closed" : "Open fixture"}</strong></span></div>
          <div className="lifecycle-action">
            {wallet.status === "connected"
              ? <TransactionButton state={lifecycle} onClick={onCloseLifecycle}/>
              : <span className="action-lock"><Wallet size={15}/> Wallet required</span>}
            <small>This submits a real signed Testnet invocation.</small>
          </div>
        </article>
      </section>
      {lifecycle.status === "success" && lifecycle.hash && <div className="transaction-result"><BadgeCheck size={18}/><div><strong>Round closed on Testnet</strong><span>{compact(lifecycle.hash, 12, 8)}</span></div><a href={explorerTransaction(lifecycle.hash)} target="_blank" rel="noreferrer">Open receipt <ArrowUpRight size={14}/></a></div>}
      {lifecycle.status === "error" && <div className="transaction-result error"><Ban size={18}/><div><strong>{lifecycle.label}</strong><span>{lifecycle.code}</span></div></div>}
    </div>
  );
}

function PortfolioPage({ wallet, role, eligibility, onConnect, onEligibility }: {
  wallet: WalletState;
  role: string;
  eligibility: AsyncState;
  onConnect: () => void;
  onEligibility: () => void;
}) {
  const connected = wallet.status === "connected";
  const participant = connected ? participants.find((item) => item.account === wallet.session.address) : undefined;
  return (
    <div className="workspace-page page-enter">
      <div className="page-title-row"><div><span className="section-kicker">ACCOUNT-BOUND STATE</span><h1>My access</h1><p>Identity remains visible. Bid values and confidential balances do not.</p></div>{!connected && <Pressable className="button-primary" onClick={onConnect}><Wallet size={16}/> Connect Freighter</Pressable>}</div>
      <div className="access-layout">
        <section className="identity-sheet">
          <div className="identity-head"><span className="identity-glyph"><CircleUserRound size={28}/></span><div><span>CONNECTED ROLE</span><h2>{role}</h2></div><StatusTag tone={connected ? "green" : "muted"}>{connected ? "Testnet" : "Offline"}</StatusTag></div>
          <div className="identity-address"><span>STELLAR ACCOUNT</span><code>{connected ? wallet.session.address : "Connect an account to resolve identity"}</code></div>
          <div className="access-checks">
            <div><span>Fixture participation</span><strong>{participant ? participant.alias : connected ? "Not registered" : "Unknown"}</strong></div>
            <div><span>Round result</span><strong>{participant ? participant.winner ? "Won" : "Lost · reclaimed" : "No private position"}</strong></div>
            <div><span>Competing bids</span><strong className="hidden"><EyeOff size={14}/> Never visible</strong></div>
          </div>
        </section>
        <section className="policy-terminal">
          <span className="section-kicker">ON-CHAIN POLICY</span>
          <h2>Eligibility boundary</h2>
          <p>The configured policy evaluates the connected account against the confidential settlement token.</p>
          <div className={`policy-readout ${eligibility.status}`}>
            <span>{eligibility.status === "loading" ? <Activity className="spin" size={19}/> : eligibility.status === "success" ? <Check size={19}/> : eligibility.status === "error" ? <Ban size={19}/> : <ShieldCheck size={19}/>}</span>
            <div><strong>{eligibility.status === "idle" ? "Not checked" : eligibility.label}</strong><small>{eligibility.status === "error" ? eligibility.code : eligibility.status === "success" ? "Policy contract returned authorized" : "Live RPC simulation"}</small></div>
          </div>
          <Pressable className="button-primary button-full" onClick={connected ? onEligibility : onConnect} disabled={eligibility.status === "loading"}>{connected ? "Run policy check" : "Connect wallet"} <ArrowRight size={15}/></Pressable>
        </section>
      </div>
    </div>
  );
}

function AuditPage({ onVerify }: { onVerify: () => void }) {
  const [disclosure, setDisclosure] = useState<AsyncState>({ status: "idle" });
  const verifyDisclosure = async () => {
    setDisclosure({ status: "loading", label: "Matching recipient and event" });
    await delay(700);
    const verified = testnetEvidence.disclosure.proof.verified
      && testnetEvidence.disclosure.verification.chainInputsReconstructed
      && testnetEvidence.disclosure.verification.designatedRecipientDecrypted
      && testnetEvidence.disclosure.verification.wrongRecipientRejected;
    setDisclosure(verified
      ? { status: "success", label: "Recipient-bound proof verified" }
      : { status: "error", label: "Disclosure mismatch", code: "DISCLOSURE_BINDING_INVALID" });
    onVerify();
  };
  return (
    <div className="workspace-page page-enter">
      <div className="page-title-row"><div><span className="section-kicker">CONTROLLED VISIBILITY</span><h1>Audit & disclosure</h1><p>Confidentiality for the market. Explicit visibility for authorized oversight.</p></div><StatusTag>Signed export verified</StatusTag></div>
      <div className="visibility-compare">
        <section className="visibility-side public-side">
          <div className="visibility-title"><span><Eye size={17}/> PUBLIC MARKET VIEW</span><StatusTag tone="muted">Permissionless</StatusTag></div>
          {participants.map((participant) => <div className="visibility-person" key={participant.account}><span className="person-index">{String(participant.registrationIndex + 1).padStart(2, "0")}</span><div><strong>{participant.alias}</strong><small>{compact(participant.account)}</small></div><b><EyeOff size={14}/> Sealed</b></div>)}
          <div className="visibility-result"><span>Winner</span><strong>{participants.find((item) => item.winner)?.alias}</strong></div>
        </section>
        <section className="visibility-side auditor-side">
          <div className="visibility-title"><span><ShieldCheck size={17}/> AUTHORIZED AUDITOR VIEW</span><StatusTag tone="ink">Local vault</StatusTag></div>
          {participants.map((participant) => <div className="visibility-person" key={participant.account}><span className="person-index">{String(participant.registrationIndex + 1).padStart(2, "0")}</span><div><strong>{participant.alias}</strong><small>Event linkage verified</small></div><b><LockKeyhole size={14}/> Restricted</b></div>)}
          <div className="visibility-result"><span>Audit export</span><strong>{compact(testnetEvidence.audit.exportIntegrity.privateExportSha256, 10, 7)}</strong></div>
        </section>
      </div>
      <section className="disclosure-workbench">
        <div className="disclosure-copy"><span className="section-kicker">DISCLOSURE RECIPIENT</span><h2>One settlement fact. One intended recipient.</h2><p>The proof binds the recipient, settlement event and encrypted value without opening unrelated account history.</p></div>
        <div className="binding-diagram">
          <span><KeyRound size={17}/> Recipient</span><i/><span><ReceiptText size={17}/> Event</span><i/><span><Fingerprint size={17}/> UltraHonk</span>
        </div>
        <Pressable className="button-primary" onClick={verifyDisclosure} disabled={disclosure.status === "loading" || disclosure.status === "success"}>{disclosure.status === "loading" ? <Activity className="spin" size={16}/> : disclosure.status === "success" ? <Check size={16}/> : <Fingerprint size={16}/>} {disclosure.status === "idle" ? "Verify disclosure" : disclosure.label}</Pressable>
      </section>
    </div>
  );
}

const evidenceRows = [
  ["RWA escrow funded", testnetEvidence.setup.roundTransactions.fundRound, "TRANSACTION"],
  ["Round opened", testnetEvidence.setup.roundTransactions.openRound, "TRANSACTION"],
  ["Participant set frozen", testnetEvidence.settlement.closeTransaction, "TRANSACTION"],
  ["Atomic settlement", testnetEvidence.settlement.finalizeTransaction, "TRANSACTION"],
  ["Maximum-bid proof", testnetEvidence.settlement.maxBidProof.sha256, "PROOF SHA-256"],
  ["Signed audit export", testnetEvidence.audit.exportIntegrity.canonicalPayloadSha256, "EXPORT SHA-256"],
  ["Recipient disclosure", testnetEvidence.disclosure.proof.sha256, "PROOF SHA-256"],
] as const;

function EvidencePage({ live, onRefresh }: { live: LiveState; onRefresh: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(value);
    window.setTimeout(() => setCopied(null), 1200);
  };
  return (
    <div className="workspace-page page-enter">
      <div className="page-title-row"><div><span className="section-kicker">APPEND-ONLY TESTNET RECORD</span><h1>Evidence</h1><p>Every product claim resolves to a receipt, proof hash or live contract read.</p></div><Pressable className="button-secondary" onClick={onRefresh}><RefreshCw className={live.status === "checking" ? "spin" : ""} size={15}/> Refresh live reads</Pressable></div>
      <section className="evidence-health">
        <div><span className={`health-signal ${live.status}`}/><span><strong>{live.status === "verified" ? "Indexer + RPC matched" : live.status === "checking" ? "Reading live contracts" : "Evidence fallback active"}</strong><small>{live.status === "verified" ? `${live.snapshot.matchedCount}/${live.snapshot.checks.length} independent checks · ledger ${live.snapshot.latestLedger.toLocaleString()}` : "Recorded Testnet artifacts remain inspectable"}</small></span></div>
        <div><span>ROUND</span><code>{compact(testnetEvidence.settlement.roundId, 10, 8)}</code></div>
        <div><span>NETWORK</span><strong>Stellar Testnet</strong></div>
      </section>
      <section className="evidence-table">
        <div className="evidence-table-head"><span>CLAIM</span><span>REFERENCE</span><span>TYPE</span><span/></div>
        {evidenceRows.map(([label, value, type]) => <div className="evidence-row" key={label}><div><span className="evidence-icon"><FileCheck2 size={16}/></span><strong>{label}</strong></div><code>{value}</code><span>{type}</span><div className="evidence-actions"><button type="button" onClick={() => void copy(value)} aria-label={`Copy ${label}`}>{copied === value ? <Check size={15}/> : <Copy size={15}/>}</button>{type === "TRANSACTION" && <a href={explorerTransaction(value)} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}><ArrowUpRight size={15}/></a>}</div></div>)}
      </section>
      <div className="limitation-band"><ShieldCheck size={18}/><div><strong>Honest boundary</strong><span>Unaudited Testnet prototype. The auction operator can decrypt bid delegations to generate the winner proof. No production or mainnet value.</span></div></div>
    </div>
  );
}

function DemoTheater({ state, onClose, onEvidence }: { state: DemoState; onClose: () => void; onEvidence: () => void }) {
  if (!state.open) return null;
  const complete = state.verified.length === demoSteps.length;
  const current = demoSteps[Math.min(state.active, demoSteps.length - 1)]!;
  return (
    <div className="demo-theater" role="dialog" aria-modal="true" aria-label="Verified Testnet story">
      <section className="verification-dialog">
        <header><div><span className="section-kicker">LIVE TESTNET VERIFICATION</span><h2>{complete ? "Round verified" : state.error ? "Verification unavailable" : "Checking receipts"}</h2></div><Pressable className="icon-pressable" onClick={onClose}><X size={18}/><span className="sr-only">Close verified story</span></Pressable></header>
        <div className={`verification-current ${state.error ? "error" : complete ? "complete" : ""}`}>
          <span>{state.error ? <Ban size={20}/> : complete ? <Check size={20}/> : <Activity className="spin" size={20}/>}</span>
          <div><strong>{complete ? "All eight checks matched" : state.error ? "Live infrastructure did not answer" : current.label}</strong><small>{complete ? "Contracts, receipts and proof hashes agree" : state.error ? "Recorded evidence remains available" : current.detail}</small></div>
          {!complete && !state.error && current.receipt && <a href={explorerTransaction(current.receipt)} target="_blank" rel="noreferrer" aria-label="Open active receipt"><ArrowUpRight size={16}/></a>}
        </div>
        <div className="demo-rail">
          {demoSteps.map((step, index) => {
            const verified = state.verified.includes(index);
            const active = state.running && state.active === index;
            const StepIcon = step.icon;
            return <div key={step.label} className={`${verified ? "verified" : ""} ${active ? "active" : ""} ${step.negative ? "negative" : ""}`}><span>{verified ? <Check size={15}/> : active ? <Activity className="spin" size={15}/> : <StepIcon size={15}/>}</span><div><strong>{step.label}</strong><small>{verified ? step.negative ? "Denial matched" : "Receipt matched" : active ? "Reading ledger" : "Queued"}</small></div></div>;
          })}
        </div>
        {state.error && <span className="demo-error-code">TESTNET_RPC_UNAVAILABLE</span>}
        <footer>{complete || state.error ? <><Pressable className="button-primary" onClick={onEvidence}>Open evidence <ArrowRight size={16}/></Pressable><Pressable className="button-secondary" onClick={onClose}>Close</Pressable></> : <span><Activity className="spin" size={14}/> Reading ledger {state.active + 1} of {demoSteps.length}</span>}</footer>
      </section>
    </div>
  );
}

export function App() {
  const [mode, setMode] = useState<AppMode>("landing");
  const [introStep, setIntroStep] = useState(0);
  const [workspace, setWorkspace] = useState<Workspace>("overview");
  const [wallet, setWallet] = useState<WalletState>({ status: "disconnected" });
  const [live, setLive] = useState<LiveState>({ status: "checking" });
  const [eligibility, setEligibility] = useState<AsyncState>({ status: "idle" });
  const [lifecycle, setLifecycle] = useState<AsyncState>({ status: "idle" });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [demo, setDemo] = useState<DemoState>({ open: false, running: false, active: 0, verified: [] });
  const demoRun = useRef(0);

  const refreshLive = useCallback(() => {
    setLive({ status: "checking" });
    const timeout = new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Testnet verification timed out")), 12_000));
    void Promise.race([import("./live").then(({ verifyLiveTestnet }) => verifyLiveTestnet()), timeout])
      .then((snapshot) => setLive({ status: snapshot.allMatched ? "verified" : "mismatch", snapshot }))
      .catch((error: unknown) => setLive({ status: "fallback", error: error instanceof Error ? error.message : "Testnet verification failed" }));
  }, []);

  useEffect(() => refreshLive(), [refreshLive]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [mode, workspace]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3_200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const connectWallet = useCallback(() => {
    setWallet({ status: "connecting" });
    setNotice(null);
    void import("./wallet")
      .then(async ({ connectFreighter, productClient }) => {
        const session = await connectFreighter();
        const round = await productClient().round(testnetEvidence.settlement.roundId);
        const nativeStatus = round.status;
        const roundStatus = Array.isArray(nativeStatus) ? String(nativeStatus[0]) : String(nativeStatus);
        setWallet({ status: "connected", session, roundStatus });
        setNotice(`Wallet connected · ${compact(session.address, 6, 5)}`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Could not connect Freighter";
        setWallet({ status: "error", message });
        setNotice(message);
      });
  }, []);

  const disconnectWallet = useCallback(() => {
    setWallet({ status: "disconnected" });
    setEligibility({ status: "idle" });
    setNotice("Wallet disconnected");
  }, []);

  const checkEligibility = useCallback(() => {
    if (wallet.status !== "connected") return connectWallet();
    setEligibility({ status: "loading", label: "Reading policy contract" });
    void import("./wallet")
      .then(({ checkPolicyEligibility }) => checkPolicyEligibility(wallet.session.address))
      .then((authorized) => setEligibility(authorized
        ? { status: "success", label: "Account is eligible" }
        : { status: "error", label: "Account is not allowlisted", code: "INVESTOR_NOT_AUTHORIZED" }))
      .catch(() => setEligibility({ status: "error", label: "Policy read failed", code: "POLICY_RPC_UNAVAILABLE" }));
  }, [connectWallet, wallet]);

  const closeLifecycle = useCallback(() => {
    if (wallet.status !== "connected") return connectWallet();
    setLifecycle({ status: "loading", label: "Awaiting Freighter signature" });
    void import("./wallet")
      .then(({ closeLifecycleRound }) => closeLifecycleRound(wallet.session))
      .then((result) => {
        setLifecycle({ status: "success", label: "Confirmed on Testnet", hash: result.hash });
        setNotice("Lifecycle round closed · receipt confirmed");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Transaction failed";
        const alreadyClosed = /RoundNotOpen|status|rejected/i.test(message);
        setLifecycle({ status: "error", label: alreadyClosed ? "Round is no longer open" : message, code: alreadyClosed ? "ROUND_NOT_OPEN" : "TRANSACTION_REJECTED" });
      });
  }, [connectWallet, wallet]);

  const startDemo = useCallback(async () => {
    const run = ++demoRun.current;
    setDemo({ open: true, running: true, active: 0, verified: [] });
    try {
      const verification = import("./live").then(({ verifyLiveTestnet }) => verifyLiveTestnet());
      await delay(500);
      const snapshot = await verification;
      if (run !== demoRun.current) return;
      const evidenceValid = testnetEvidence.setup.unauthorizedRegistrationRejected
        && testnetEvidence.disclosure.verification.designatedRecipientDecrypted
        && testnetEvidence.settlement.maxBidProof.marketStatementMatched;
      if (!snapshot.allMatched || !evidenceValid) throw new Error("Evidence mismatch");
      for (let index = 0; index < demoSteps.length; index += 1) {
        if (run !== demoRun.current) return;
        setDemo((current) => ({ ...current, active: index }));
        await delay(index === 2 ? 800 : 560);
        if (run !== demoRun.current) return;
        setDemo((current) => ({ ...current, verified: [...current.verified, index] }));
      }
      setDemo((current) => ({ ...current, running: false, active: demoSteps.length }));
    } catch (error) {
      if (run !== demoRun.current) return;
      setDemo((current) => ({ ...current, running: false, error: error instanceof Error ? error.message : "Verification failed" }));
    }
  }, []);

  const closeDemo = () => {
    demoRun.current += 1;
    setDemo({ open: false, running: false, active: 0, verified: [] });
  };
  const openEvidence = () => {
    closeDemo();
    setMode("console");
    setWorkspace("evidence");
  };
  const completeIntro = () => {
    setMode("console");
    setWorkspace("overview");
  };
  const role = useMemo(() => walletRole(wallet), [wallet]);

  return (
    <>
      {mode === "landing" && (
        <Landing
          wallet={wallet}
          live={live}
          onConnect={connectWallet}
          onDisconnect={disconnectWallet}
          onIntro={() => { setIntroStep(0); setMode("intro"); }}
          onConsole={() => setMode("console")}
        />
      )}
      {mode === "intro" && (
        <Intro step={introStep} onStep={setIntroStep} onBack={() => setMode("landing")} onComplete={completeIntro}/>
      )}
      {mode === "console" && (
        <div className="console-shell page-enter">
          <Sidebar workspace={workspace} open={sidebarOpen} onSelect={setWorkspace} onClose={() => setSidebarOpen(false)}/>
          <div className="console-main">
            <ConsoleHeader workspace={workspace} wallet={wallet} live={live} onConnect={connectWallet} onDisconnect={disconnectWallet} onMenu={() => setSidebarOpen(true)}/>
            {workspace === "overview" && (
              <OverviewPage wallet={wallet} live={live} role={role} eligibility={eligibility} lifecycle={lifecycle} onConnect={connectWallet} onEligibility={checkEligibility} onCloseLifecycle={closeLifecycle} onRunDemo={() => void startDemo()} onEvidence={() => setWorkspace("evidence")}/>
            )}
            {workspace === "portfolio" && (
              <PortfolioPage wallet={wallet} role={role} eligibility={eligibility} onConnect={connectWallet} onEligibility={checkEligibility}/>
            )}
            {workspace === "audit" && (
              <AuditPage onVerify={() => setNotice("Disclosure proof bindings matched")}/>
            )}
            {workspace === "evidence" && (
              <EvidencePage live={live} onRefresh={refreshLive}/>
            )}
          </div>
        </div>
      )}
      <DemoTheater state={demo} onClose={closeDemo} onEvidence={openEvidence}/>
      {notice && <div className="toast" role="status"><Check size={15}/><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification"><X size={14}/></button></div>}
      {wallet.status === "error" && !notice && <div className="toast error" role="alert"><Ban size={15}/><span>{wallet.message}</span><button type="button" onClick={() => setWallet({ status: "disconnected" })} aria-label="Dismiss wallet error"><X size={14}/></button></div>}
    </>
  );
}

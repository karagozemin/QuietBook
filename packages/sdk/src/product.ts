import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { InvokeResult, Signer } from "@ctd/sdk";
import type { RevokeSpenderWitness, SetSpenderWitness } from "./spender.js";
import { encodeRevokeSpenderData, encodeSetSpenderData } from "./payload.js";

export type RoundConfigInput = {
  issuer: string;
  rwaToken: string;
  rwaLot: bigint;
  confidentialToken: string;
  controller: string;
  eligibilityPolicy: string;
  maxBidVerifier: string;
  auditorId: number;
  reservePublic: bigint;
  bidDeadlineLedger: number;
  settlementDeadlineLedger: number;
};

export type ProductContracts = {
  market: string;
  confidentialToken: string;
};

export interface ProductChain {
  invoke(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signer: Signer,
  ): Promise<InvokeResult>;
  simulate(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal>;
}

export type SealedBidInput = {
  roundId: string;
  bidder: string;
  controller: string;
  settlementDeadlineLedger: number;
  witness: SetSpenderWitness;
  proof: Uint8Array;
};

export type AtomicBidInput = SealedBidInput & {
  depositAmount: bigint;
};

export type ReclaimBidInput = {
  account: string;
  controller: string;
  witness: RevokeSpenderWitness;
  proof: Uint8Array;
};

const address = (value: string) => new Address(value).toScVal();
function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("round id must be 32-byte hex");
  return Uint8Array.from(hex.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const bytes32 = (hex: string) => nativeToScVal(fromHex(hex), { type: "bytes" });

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key]! })),
  );
}

export function encodeRoundConfig(config: RoundConfigInput): xdr.ScVal {
  return struct({
    auditor_id: xdr.ScVal.scvU32(config.auditorId),
    bid_deadline_ledger: xdr.ScVal.scvU32(config.bidDeadlineLedger),
    confidential_token: address(config.confidentialToken),
    controller: address(config.controller),
    eligibility_policy: address(config.eligibilityPolicy),
    issuer: address(config.issuer),
    max_bid_verifier: address(config.maxBidVerifier),
    reserve_public: nativeToScVal(config.reservePublic, { type: "i128" }),
    rwa_lot: nativeToScVal(config.rwaLot, { type: "i128" }),
    rwa_token: address(config.rwaToken),
    settlement_deadline_ledger: xdr.ScVal.scvU32(config.settlementDeadlineLedger),
  });
}

export class QuietBookClient {
  constructor(
    readonly chain: ProductChain,
    readonly contracts: ProductContracts,
  ) {}

  async createRound(config: RoundConfigInput, signer: Signer) {
    const result = await this.chain.invoke(
      this.contracts.market,
      "create_round",
      [encodeRoundConfig(config)],
      signer,
    );
    if (!result.returnValue) throw new Error("create_round returned no round id");
    return { transaction: result.hash, roundId: toHex(result.returnValue.bytes()) };
  }

  async createAndOpenRound(
    config: RoundConfigInput,
    auditorId: number,
    registerData: xdr.ScVal,
    signer: Signer,
  ) {
    const result = await this.chain.invoke(
      this.contracts.market,
      "create_and_open_round",
      [encodeRoundConfig(config), xdr.ScVal.scvU32(auditorId), registerData],
      signer,
    );
    if (!result.returnValue) throw new Error("create_and_open_round returned no round id");
    return { transaction: result.hash, roundId: toHex(result.returnValue.bytes()) };
  }

  async registerController(
    roundId: string,
    auditorId: number,
    registerData: xdr.ScVal,
    signer: Signer,
  ) {
    return this.chain.invoke(
      this.contracts.market,
      "register_controller",
      [bytes32(roundId), xdr.ScVal.scvU32(auditorId), registerData],
      signer,
    );
  }

  async fundAndOpen(roundId: string, signer: Signer) {
    const funded = await this.chain.invoke(
      this.contracts.market,
      "fund_round",
      [bytes32(roundId)],
      signer,
    );
    const opened = await this.chain.invoke(
      this.contracts.market,
      "open_round",
      [bytes32(roundId)],
      signer,
    );
    return { fundTransaction: funded.hash, openTransaction: opened.hash };
  }

  async submitSealedBid(input: SealedBidInput, signer: Signer) {
    const delegated = await this.chain.invoke(
      this.contracts.confidentialToken,
      "set_spender",
      [
        address(input.bidder),
        address(input.controller),
        xdr.ScVal.scvU32(input.settlementDeadlineLedger),
        encodeSetSpenderData(input.witness, input.proof),
      ],
      signer,
    );
    const registered = await this.chain.invoke(
      this.contracts.market,
      "register_bid",
      [bytes32(input.roundId), address(input.bidder)],
      signer,
    );
    return { delegationTransaction: delegated.hash, registrationTransaction: registered.hash };
  }

  async submitAtomicBid(input: AtomicBidInput, signer: Signer) {
    return this.chain.invoke(
      this.contracts.market,
      "submit_bid",
      [
        bytes32(input.roundId),
        address(input.bidder),
        nativeToScVal(input.depositAmount, { type: "i128" }),
        encodeSetSpenderData(input.witness, input.proof),
      ],
      signer,
    );
  }

  async withdrawBid(
    roundId: string,
    input: ReclaimBidInput,
    signer: Signer,
  ) {
    return this.chain.invoke(
      this.contracts.market,
      "withdraw_bid",
      [
        bytes32(roundId),
        address(input.account),
        encodeRevokeSpenderData(input.witness, input.proof),
      ],
      signer,
    );
  }

  async reclaimBid(input: ReclaimBidInput, signer: Signer) {
    return this.chain.invoke(
      this.contracts.confidentialToken,
      "revoke_spender",
      [
        address(input.account),
        address(input.controller),
        encodeRevokeSpenderData(input.witness, input.proof),
      ],
      signer,
    );
  }

  async closeRound(roundId: string, signer: Signer) {
    return this.chain.invoke(this.contracts.market, "close_round", [bytes32(roundId)], signer);
  }

  async finalizeRound(
    roundId: string,
    winnerIndex: number,
    maxBidProof: Uint8Array,
    spenderTransferData: xdr.ScVal,
    signer: Signer,
  ) {
    return this.chain.invoke(
      this.contracts.market,
      "finalize",
      [
        bytes32(roundId),
        xdr.ScVal.scvU32(winnerIndex),
        nativeToScVal(maxBidProof, { type: "bytes" }),
        spenderTransferData,
      ],
      signer,
    );
  }

  async reclaimRwa(roundId: string, signer: Signer) {
    return this.chain.invoke(this.contracts.market, "reclaim_rwa", [bytes32(roundId)], signer);
  }

  async round(roundId: string) {
    return scValToNative(
      await this.chain.simulate(this.contracts.market, "get_round", [bytes32(roundId)]),
    ) as Record<string, unknown>;
  }

  async bidders(roundId: string) {
    return scValToNative(
      await this.chain.simulate(this.contracts.market, "get_bidders", [bytes32(roundId)]),
    ) as string[];
  }
}

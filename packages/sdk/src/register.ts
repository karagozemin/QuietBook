import {
  addressToField,
  buildRegisterWitness,
  fieldIn,
  type KeyPair,
  type NoirInputs,
  type Point,
} from "@ctd/sdk";

export interface QuietBookRegisterWitness {
  inputs: NoirInputs;
  payload: { y: Point; pvk: Point };
}

export function buildAccountBoundRegisterWitness(
  keys: KeyPair,
  account: string,
): QuietBookRegisterWitness {
  const base = buildRegisterWitness(keys);
  return {
    payload: base.payload,
    inputs: {
      ...base.inputs,
      _acct_f: fieldIn(addressToField(account)),
    },
  };
}

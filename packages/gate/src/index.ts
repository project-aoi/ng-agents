// @ng/gate — primitive ⑥: monotonic permissions, secret proxy, version-bound approvals, dual-ledger budget.

export {
  createGate,
  DEFAULT_OWNER_ADDRESSES,
  DEFAULT_TOKEN_TTL_MS,
  DEFAULT_TRUST_STREAK,
  type GateOptions,
  type GateService,
} from "./gate";
export { attenuateBounds, intersectPatterns, isAddressPattern, meetBounds, minimizePatterns, type AttenuateOptions } from "./attenuate";
export {
  ACTION_TYPES,
  SIDE_EFFECTS,
  actionShapeFeedback,
  boundsFeedback,
  deliveryAllowed,
  derivedSideEffect,
  effectiveSideEffect,
  maxSideEffect,
  ownerOnlyApproval,
  parseActionClass,
  pickRule,
  ruleApplies,
  ruleInputForClass,
  ruleSpecificity,
  type BoundsContext,
} from "./policy";
export { approvalCardFor, describeAction } from "./card";
export {
  SECRET_ENV_PREFIX,
  envSecretStore,
  memorySecretStore,
  redactSecrets,
  secretEnvName,
  type EnvSecretStoreOptions,
  type SecretStore,
} from "./secrets";

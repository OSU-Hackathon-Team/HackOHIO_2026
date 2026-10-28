import {
  CapabilityDefinition,
  ElectronContractSpec,
  type CapabilityIntakeRequest,
  type IndependentVerdict,
  type ImplementationSource,
  type PublicTestCase,
  type ReviewAttestation,
} from "@splice/contracts";
import { hashJson } from "./identity.js";

/**
 * Adapt the immutable public Electron handoff; the archive, oracle and candidate stay upstream.
 *
 * A handoff channel is an IPC name chosen by the original application, while an operation is the
 * capability behavior downstream chose to promise. The caller states that mapping explicitly:
 * deriving one name from the other would invent the boundary this gate exists to check.
 */
export function fromElectronContract(
  rawSpec: unknown,
  definitionValue: CapabilityDefinition,
  channelOperations: Readonly<Record<string, string>>,
  implementation: ImplementationSource,
  publicTests: PublicTestCase[],
  reviewAttestation: ReviewAttestation | null,
  independentVerdict: IndependentVerdict | null = null,
): CapabilityIntakeRequest {
  const spec = ElectronContractSpec.parse(rawSpec);
  const definition = CapabilityDefinition.parse(definitionValue);
  const artifactHash = hashJson(rawSpec);
  const declaredBlockers = [...(spec.application.blockers ?? []), ...(spec.application.unresolved ?? [])];
  if (declaredBlockers.length > 0) {
    throw new Error(`Electron handoff declares unresolved readiness blockers: ${declaredBlockers.join("; ")}`);
  }
  if (!reviewAttestation || reviewAttestation.status !== "approved" || reviewAttestation.artifact_hash !== artifactHash) {
    throw new Error("Electron contract review approval must be explicit and pin the exact public spec hash");
  }
  if (
    definition.origin.kind !== "electron_contract" ||
    definition.origin.stage !== "electron_reconstruction" ||
    definition.origin.artifact_hash !== artifactHash ||
    definition.origin.source_app !== spec.application.name
  ) {
    throw new Error("CapabilityDefinition origin does not pin this public Electron contract");
  }
  if (implementation.kind === "blueprint") {
    throw new Error("Electron contracts require an explicit TypeScript or C implementation source");
  }

  const channels = Object.keys(spec.channels);
  const declared = new Map(Object.entries(channelOperations));
  for (const channel of channels) {
    if (!declared.has(channel)) throw new Error(`Channel ${channel} has no declared capability operation`);
  }
  const excluded = new Set((spec.channel_exclusions ?? []).map((item) => item.channel));
  for (const channel of declared.keys()) {
    if (!(channel in spec.channels)) {
      throw new Error(`Operation mapping names channel ${channel} the handoff does not declare${excluded.has(channel) ? " (it is an excluded channel)" : ""}`);
    }
  }
  const operations = new Set(definition.operations.map((operation) => operation.name));
  const answered = new Map<string, string>();
  for (const [channel, operation] of declared) {
    if (!operations.has(operation)) throw new Error(`Channel ${channel} maps to undeclared operation ${operation}`);
    const shared = [...answered.entries()].find(([, name]) => name === operation);
    if (shared) throw new Error(`Channels ${shared[0]} and ${channel} cannot answer the same operation ${operation}; declare one operation per verified channel`);
    answered.set(channel, operation);
  }
  for (const operation of operations) {
    if (![...answered.values()].includes(operation)) {
      throw new Error(`Operation ${operation} does not answer a declared handoff channel`);
    }
  }

  return {
    definition,
    origin_artifact: rawSpec,
    review_attestation: reviewAttestation,
    implementation,
    public_tests: publicTests,
    independent_verdict: independentVerdict,
  };
}

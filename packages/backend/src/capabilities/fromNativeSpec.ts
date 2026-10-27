import {
  CapabilityDefinition,
  NativeSubsystemSpec,
  type CapabilityIntakeRequest,
  type IndependentVerdict,
  type PublicTestCase,
  type ReviewAttestation,
  type ImplementationSource,
} from "@splice/contracts";
import { hashJson } from "./identity.js";

/** Adapt only the immutable public native spec; analyst dossier and binary never enter intake. */
export function fromNativeSpec(
  rawSpec: unknown,
  definitionValue: CapabilityDefinition,
  implementation: ImplementationSource,
  publicTests: PublicTestCase[],
  reviewAttestation: ReviewAttestation | null,
  independentVerdict: IndependentVerdict | null = null,
): CapabilityIntakeRequest {
  const spec = NativeSubsystemSpec.parse(rawSpec);
  const definition = CapabilityDefinition.parse(definitionValue);
  const artifactHash = hashJson(spec);
  if (spec.status !== "ready_for_review") throw new Error("Draft native specs cannot be adapted for implementation");
  if (!reviewAttestation || reviewAttestation.status !== "approved" || reviewAttestation.artifact_hash !== artifactHash) {
    throw new Error("Native spec review approval must be explicit and pin the exact public spec hash");
  }
  if (
    definition.origin.kind !== "native_subsystem_spec" ||
    definition.origin.stage !== "native_spec" ||
    definition.origin.artifact_hash !== artifactHash
  ) {
    throw new Error("CapabilityDefinition origin does not pin this public native spec");
  }
  if (implementation.kind === "blueprint") throw new Error("Native specs require an explicit TypeScript or C implementation source");
  return {
    definition,
    origin_artifact: spec,
    review_attestation: reviewAttestation,
    implementation,
    public_tests: publicTests,
    independent_verdict: independentVerdict,
  };
}

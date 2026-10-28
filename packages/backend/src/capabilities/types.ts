import type {
  CapabilityIntakeRecord,
  CapabilityPackage,
  CapabilityDefinition,
  Readiness,
  IndependentVerdict,
  PublicTestCase,
  ImplementationSource,
} from "@splice/contracts";

export interface ArtifactFile {
  path: string;
  data: Buffer;
}

/** Read-only surface used by composition, export and verification code. */
export interface CapabilityResolver {
  listPackages(): Promise<CapabilityPackage[]>;
  getPackage(packageId: string): Promise<CapabilityPackage | null>;
  getDefinition(packageId: string): Promise<CapabilityDefinition | null>;
  /** Directory containing the package's verified artifacts. */
  artifactRoot(pkg: CapabilityPackage): string;
  readArtifact(pkg: CapabilityPackage, path: string): Promise<Buffer>;
}

/** Server-owned content-addressed registry. Uploaded verification fields are never trusted. */
export interface CapabilityRegistry extends CapabilityResolver {
  getIntake(intakeId: string): Promise<CapabilityIntakeRecord | null>;
  listIntakes(): Promise<CapabilityIntakeRecord[]>;
  putIntake(record: CapabilityIntakeRecord): Promise<void>;
  putOriginArtifact(hash: string, artifact: unknown): Promise<void>;
  putPackage(pkg: CapabilityPackage, files: ArtifactFile[]): Promise<void>;
}

export interface BuildHooks {
  signal?: AbortSignal;
  onStage(stage: string, message: string, pct: number): void;
  onLog?(message: string): void;
}

export interface BuiltPackage {
  package: CapabilityPackage;
  files: ArtifactFile[];
}

export interface BuildInput {
  definition: CapabilityDefinition;
  /** Definition hash computed by the intake record; recomputed when absent. */
  hash_definition?: string;
  implementation: ImplementationSource;
  public_tests: PublicTestCase[];
  intake_id: string;
  intake_readiness?: Readiness;
  independent_verdict?: IndependentVerdict | null;
}

export interface PackageBuilder {
  build(input: BuildInput, hooks: BuildHooks): Promise<BuiltPackage>;
}

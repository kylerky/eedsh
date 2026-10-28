/**
 * Read-only exploration views over the loaded config. The CLI builds them from
 * the validated config value; they never import the config project's authoring
 * module, never write profile files, and never publish. A view is a snapshot
 * for one evaluation and is rebuilt by the session on load, reload, profile
 * switch, preview change, and successful sync.
 * @module @eedsh/cli/repl/views
 */
import {
  bundle as bundleHandle,
  type BundleQuery,
  type NamedBundle,
  type Preset,
  type ResolutionOrigin,
  type Row,
} from '@eedsh/config'
import type { EedshConfig, PlanLayer, ProfilePlan } from '@eedsh/plan'
import * as Result from 'effect/Result'
import type * as Schema from 'effect/Schema'

/** A view failure shaped like a session failure, so the prompt can print it. */
export class ViewError extends Error {
  readonly _tag = 'ReplSessionError'
  readonly code: string
  readonly lines: readonly string[]

  constructor(input: {
    readonly code: string
    readonly message: string
    readonly lines?: readonly string[]
  }) {
    super(input.message)
    this.name = 'ViewError'
    this.code = input.code
    this.lines = input.lines ?? [input.message]
  }
}

/**
 * One bundle selection in a profile, querying that profile's installed copy.
 * A rooted bundle is query-only and never becomes a plan selection here.
 */
export class BundleView {
  /** The bundle package name. */
  readonly name: string
  /** The authored source override, when one was declared. */
  readonly source: string | undefined
  /** The profile the queries resolve against. */
  readonly profile: string
  private readonly query: BundleQuery

  constructor(selection: NamedBundle, profile: string) {
    this.name = selection.name
    this.source = selection.source
    this.profile = profile
    const options = selection.source === undefined ? {} : { source: selection.source }
    this.query = bundleHandle(selection.name, options).fromProfile(profile)
  }

  /** The bundle selection as plain plan data. */
  toJSON(): NamedBundle {
    return this.source === undefined
      ? { kind: 'bundle', name: this.name }
      : { kind: 'bundle', name: this.name, source: this.source }
  }

  /** Every declared row, as typed immutable handles. */
  rows(): readonly Row[] {
    return this.query.rows()
  }

  /** Every declared preset, as typed immutable handles. */
  presets(): readonly Preset[] {
    return this.query.presets()
  }

  /**
   * One row by Loader id.
   * @param id - the Loader row id.
   * @returns the typed row.
   */
  row(id: string): Row {
    return this.query.row(id)
  }

  /**
   * One preset by preset id.
   * @param id - the preset's own config id.
   * @returns the typed preset.
   */
  preset(id: string): Preset {
    return this.query.preset(id)
  }

  /** The resolved bundle package version. */
  version(): string {
    return this.query.version()
  }

  /** The resolved bundle package directory. */
  packageDir(): string {
    return this.query.packageDir()
  }

  /** Where the bundle was resolved from. */
  origin(): ResolutionOrigin {
    return this.query.origin()
  }
}

/** One declared profile and its validated-plan result. */
export class ProfileView {
  /** The profile key. */
  readonly name: string
  /** Whether the declared profile is a valid plan. */
  readonly valid: boolean
  /** The native schema failure message when the profile is invalid. */
  readonly error: string | undefined
  private readonly outcome: Result.Result<ProfilePlan, Schema.SchemaError>

  constructor(name: string, outcome: Result.Result<ProfilePlan, Schema.SchemaError>) {
    this.name = name
    this.outcome = outcome
    this.valid = Result.isSuccess(outcome)
    this.error = Result.isFailure(outcome) ? outcome.failure.message : undefined
  }

  /** The per-profile validation result. */
  result(): Result.Result<ProfilePlan, Schema.SchemaError> {
    return this.outcome
  }

  /**
   * The validated plan, or a tagged failure for an invalid profile.
   * @returns the profile plan.
   */
  plan(): ProfilePlan {
    if (Result.isFailure(this.outcome)) {
      const lines = [`profile ${JSON.stringify(this.name)} is invalid`, ...this.outcome.failure.message.split('\n')]
      throw new ViewError({
        code: 'repl.invalid_profile',
        message: lines[0] ?? `profile ${JSON.stringify(this.name)} is invalid`,
        lines,
      })
    }
    return this.outcome.success
  }

  /** The profile's ordered bundle selections, queryable against the profile. */
  bundles(): readonly BundleView[] {
    return this.plan().bundles.flatMap((selection) =>
      selection.kind === 'bundle' ? [new BundleView(selection, this.name)] : [],
    )
  }

  /** The profile's ordered generated patch layers. */
  layers(): readonly PlanLayer[] {
    return this.plan().layers
  }
}

/** The loaded config as an exploration entry point. */
export class ConfigView {
  /** The config's exact DSH pin. */
  readonly dsh: string
  /** The declared default profile, when one is named. */
  readonly defaultProfile: string | undefined
  private readonly views: ReadonlyMap<string, ProfileView>

  constructor(config: EedshConfig) {
    this.dsh = config.dsh
    this.defaultProfile = config.defaultProfile
    this.views = new Map(
      Object.entries(config.profiles).map(([name, outcome]) => [
        name,
        new ProfileView(name, outcome),
      ]),
    )
  }

  /** Every declared profile in authored order. */
  profiles(): readonly ProfileView[] {
    return [...this.views.values()]
  }

  /**
   * One declared profile by name.
   * @param name - the profile key.
   * @returns the profile view, or undefined when undeclared.
   */
  profile(name: string): ProfileView | undefined {
    return this.views.get(name)
  }
}

#!/usr/bin/env node
import { runCli } from './cli'

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error('eedsh:', error)
    process.exitCode = 1
  },
)

#!/usr/bin/env node
import { runEedsh } from './cli'

runEedsh(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error('eedsh:', error)
    process.exitCode = 1
  },
)

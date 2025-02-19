#! /usr/bin/env node

import { Command } from 'commander';
import Exporter from './exporter.js';
import { defaultRedirectPort } from './login.js';

function commaSeparatedList(value: string, _previous: string[]): string[] {
  return value.split(',');
}

const program = new Command();
program
  .version('1.0.2')
  .description('Export Dropbox Paper 2020+ documents')
  .option('-v, --verbose', 'Verbose output')
  .option('--formats <string>', 'Formats to export, comma separated', commaSeparatedList, ["md", "html"])
  .option('--directory <string>', 'Directory in Dropbox to export')
  .option('--fresh', 'Restart export from scratch')
  .option('--client-id <string>', 'Client ID for authorization')
  .option('--redirect-port <number>', 'Redirect port for authorization',
    defaultRedirectPort.toString())
  .arguments('<output>')
  .action(async (output, options) => {
    try {
      await Exporter.run({ output, ...options });
    } catch (e) {
      console.error((e as Error).toString());
    }
  });
program.parse(process.argv);

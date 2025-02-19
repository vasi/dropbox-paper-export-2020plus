import { Command } from 'commander';
import Exporter from './exporter';
import { defaultRedirectPort } from './login';

function commaSeparatedList(value: string, _previous: string[]): string[] {
  return value.split(',');
}

const program = new Command();
program
  .version('1.0.0')
  .description('Export Dropbox Paper 2020+ documents')
  .option('-v, --verbose', 'Verbose output')
  .option('--client-id <string>', 'Client ID for authorization')
  .option('--redirect-port <number>', 'Redirect port for authorization',
    defaultRedirectPort.toString())
  .option('--formats <string>', 'Formats to export', commaSeparatedList, ["md", "html"])
  .arguments('<output>')
  .action(async (output, options) => {
    const exporter = await Exporter.create({ output, ...options });
    await exporter.run();
  });
program.parse(process.argv);

import { Command } from 'commander';
import Exporter from './exporter';

const program = new Command();
program
  .version('1.0.0')
  .description('Export Dropbox Paper 2020+ documents')
  .option('-v, --verbose', 'Verbose output')
  .arguments('<output>')
  .action(async (output, options) => {
    const exporter = await Exporter.create({ output, ...options });
    await exporter.run();
  });
program.parse(process.argv);

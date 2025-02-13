import { Command } from 'commander';
import { exportAll } from './paper';

const program = new Command();
program
  .version('1.0.0')
  .description('Export Dropbox Paper 2020+ documents')
  .arguments('<output>')
  .action(exportAll);
program.parse(process.argv);

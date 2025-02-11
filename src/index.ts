import { Command } from 'commander';

const program = new Command();
program
  .version('1.0.0')
  .description('Export Dropbox Paper 2020+ documents')
  .action((options) => {
    console.log('Hello, world!');
  });
program.parse(process.argv);

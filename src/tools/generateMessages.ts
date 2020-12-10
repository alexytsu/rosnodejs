import * as path from 'path';
import rosnodejs from '../index';
import { ArgumentParser } from 'argparse';

async function main(): Promise<void> {
  const parser = new ArgumentParser({
    add_help: true,
    description: 'Utility script to generate ROS messages'
  });

  parser.add_argument(
    '-p', '--pkg',
    {
      type: 'str',
      help: 'Message package to build (e.g. std_msgs). Also builds dependencies'
    }
  );
  parser.add_argument(
    '-o', '--output',
    {
      type: 'str',
      help: 'Directory to output message into (e.g. /tmp). Messages are built to devel space by default'
    }
  );
  parser.add_argument(
    '-v', '--verbose',
    {
      action: 'store_true'
    }
  );
  parser.add_argument(
    '-t', '--types',
    {
      action: 'store_true',
      help: 'Also generate a type file for generated messages'
    }
  );

  const args = parser.parse_args();

  if (args.output) {
    args.output = path.resolve(args.output);
  }

  if (args.pkg) {
    await rosnodejs.generateMessages({
      package: args.pkg,
      outputDir: args.output,
      verbose: args.verbose
    });
  }
  else {
    try {
      await rosnodejs.generateMessages({
        outputDir: args.output,
        verbose: args.verbose,
        generateTypes: args.types
      });
    }
    catch(err) {
      console.error('Error while generating messages!');
      console.error(err);
      process.exit(1)
    }
  }
}

main();
/*jslint node: true, vars: true, nomen: true */
'use strict';

var commander;
try {
  commander = require('commander');

} catch (x) {
  console
      .error("In order to use this command, you must install 'commander' (npm install commander)");
  process.exit(-1);
}

var debug = require('debug')('freebox-qml-run:cli');
var freebox = require('./lib/freebox-qml-run');

commander.version(require("./package.json").version);

commander.option("-t --target <host>", "Freebox host");
commander.option("-e --entryPoint <entryPoint>", "Application entry point");
commander.option("--mdnsSearchTimeout <milliseconds>",
    "Freebox search timout in milliseconds", parseInt);

commander.command('run <applicationPath>').description("Run qml program").action(
    function(manifestPath) {
      freebox.run(manifestPath, {
        freeboxAddress : commander.target,
        searchTimeout : commander.mdnsSearchTimeout,
        entryPoint : commander.entryPoint

      }, function(error) {
        if (error) {
          console.error(error);
          return;
        }
      });
    });

commander.parse(process.argv);

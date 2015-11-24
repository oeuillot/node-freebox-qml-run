/*jslint node: true, vars: true, nomen: true */
'use strict';

var commander = require('commander');
var debug = require('debug')('freebox-qml-run:cli');
var freebox = require('./lib/freebox-qml-run');

commander.version(require("./package.json").version);

commander.option("--host <host>", "Freebox host");

commander.command('run').description("Run qml program").action(
    function(programPath) {
      if (commander.host) {
        freebox.runQML(programPath, {
          freeboxAddress : commander.host
        });
        return;
      }

      freebox.search(1000 * 20, 1, function(error, freeboxAddresses) {
        if (error) {
          console.error(error);
          return;
        }
        console.log("Search returns=", freeboxAddresses);

        if (!freeboxAddresses || !freeboxAddresses.length) {
          console.error("Can not find a freebox !");
          return;
        }

        freebox.runQML(programPath, freeboxAddresses[0], function(error) {
          if (error) {
            console.error(error);
            return;
          }
        });
      });
    });

commander.parse(process.argv);

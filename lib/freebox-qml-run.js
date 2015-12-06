/*jslint node: true, vars: true, nomen: true */
'use strict';

var debug = require('debug')('freebox-qml-run');
var request = require('request');
var send = require('send');
var http = require('http');
var myLocalIp = require('my-local-ip');
var Path = require('path');
var URL = require('url');
var mdns = require('mdns-js');
var os = require('os');
var connect = require('connect');
var serveStatic = require('serve-static');
var net = require('net');
var EventEmitter = require('events');

var DEFAULT_TIMEOUT_MS = 1000 * 5;

/**
 * @callback searchResponse
 * @param {*}
 *            error
 * @param {Object[]}
 *            server
 * @param {string}
 *            server[].freeboxAddress Freebox address
 * @param {string}
 *            [server[].interfaceAddress] Host address to contact the Freebox
 */

/**
 * Search for freeboxes
 * 
 * @param {number}
 *            [timeoutMs=5000]
 * @param {number}
 *            [maxCount=0]
 * @param {searchResponse}
 *            callback Returns an array of object { freeboxAddress: "X.Y.Z.A" [, interfaceAddress: "B.C.D.E"] }
 */
function searchFreebox(timeoutMs, maxCount, callback) {
  if (arguments.length == 2) {
    callback = maxCount;
    maxCount = undefined;

  } else if (arguments.length == 1) {
    callback = timeoutMs;
    timeoutMs = undefined;
  }

  maxCount = maxCount || 0;
  timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;

  debug("SearchFreebox: timeoutMs=" + timeoutMs);

  var browser = mdns.createBrowser(mdns.tcp('_fbx-devel'));
  browser.on('ready', function onReady() {
    debug("SearchFreebox: browser is ready");
    browser.discover();
  });

  var ret = [];

  var found = {};

  var myNetworkInterfaces = os.networkInterfaces();

  browser.on('update', function onUpdate(data) {
    debug("SearchFreebox: data=", data);
    var ads = data.addresses;
    if (!ads || !ads.length) {
      return;
    }

    var interfaceAddress;
    var networkInterface = data.networkInterface;
    if (networkInterface) {
      var interfaces = myNetworkInterfaces[networkInterface];
      if (interfaces) {
        for (var j = 0; j < interfaces.length; j++) {
          var it = interfaces[j];

          if (it.family === 'IPv4' && !it.internal) {
            interfaceAddress = it.address;
            break;
          }
        }
      }
    }

    for (var i = 0; i < ads.length; i++) {
      var ad = ads[i];
      if (found[ad]) {
        continue;
      }

      found[ad] = true;

      var r = {
        freeboxAddress : ad
      };
      if (interfaceAddress) {
        r.interfaceAddress = interfaceAddress;
      }

      ret.push(r);

      if (!maxCount || ret.length >= maxCount) {
        break;
      }
    }

    if (maxCount > 0 && ret.length < maxCount) {
      return;
    }

    clearTimeout(timeoutId);
    browser.stop();
    browser = null;

    callback(null, ret);
  });

  var timeoutId = setTimeout(function() {
    if (!browser) {
      return;
    }
    debug("SearchFreebox: TIMEOUT");
    browser.stop();
    browser = null;
    callback(null, ret);
  }, timeoutMs);
}

/**
 * @callback runQMLFilter
 * @param {http.IncomingMessage}
 *            request
 * @param {http.ServerResponse}
 *            response
 */

function sendRequest(manifestUrl, wait, freeboxAddress, entryPoint, callback) {

  var json = {
    id : "0",
    jsonrpc : "2.0",
    method : "debug_qml_app",
    params : {
      entry_point : entryPoint || "main",
      manifest_url : manifestUrl, // "http://" + myHostname + "/manifest.json",
      wait : wait
    // !!options.wait
    }
  };

  request({
    url : "http://" + freeboxAddress + "/pub/devel",
    method : "POST",
    json : true,
    body : json

  }, function(error, response, body) {
    if (error) {
      debug("Request error", error);

      return callback(error);
    }

    debug("Freebox response.statusCode=", response.statusCode,
        "response.statusMessage=", response.statusMessage, "body=", body);

    if (!body) {
      return callback(new Error("No body !"));
    }

    if (body.error) {
      var errorJson = new Error("JSONRPC error: " + body.error.message);
      errorJson.jsonCode = body.error.code;

      return callback(errorJson);
    }

    // ouvre les 2 sockets pour verifier que le process est bien lancé !

    var ret = new EventEmitter();
    ret.running = true;

    var outputConnection = net.createConnection(body.result.stdout_port,
        freeboxAddress, function() {
          debug("Output connected !");
          ret.output = outputConnection;

          if (debug.enabled) {
            outputConnection.on('data', function(buffer) {
              debug('[OUTPUT]', String(buffer));
            });
          }

          outputConnection.on('end', function() {
            debug("Output end !");
            if (!ret.running) {
              return;
            }
            ret.running = false;
            ret.emit('end');
          });

          var errorConnection = net.createConnection(body.result.stderr_port,
              freeboxAddress, function() {
                debug("Error connected !");
                ret.error = errorConnection;

                if (debug.enabled) {
                  errorConnection.on('data', function(buffer) {
                    debug('[ERROR ]', String(buffer));
                  });
                }

                errorConnection.on('end', function() {
                  debug("Error end !");
                  if (!ret.running) {
                    return;
                  }
                  ret.running = false;
                  ret.emit('end');
                });

                return callback(null, ret);
              });
        });

  });
}

/**
 * @callback runQMLResponse
 * @param {*}
 *            error
 * @param {Object}
 *            server
 * @param {function}
 *            server.close Close the server
 */

/**
 * Run a QML application on a freebox
 * 
 * @param {string}
 *            manifestPath Path to the manifest.json (without manifest.json)
 * @param {Object}
 *            [options] Options
 * @param {string}
 *            [options.freeboxAddress] Freebox host
 * @param {string}
 *            [options.interfaceAddress] Interface address to use to contact the freebox
 * @param {number}
 *            [options.wait=5000] Ask the freebox to wait before launching qml application
 * @param {runQMLFilter}
 *            [options.filterFunc] Ask the freebox to wait before launching qml application
 * @param {http.Server}
 *            [options.server] Optional http server
 * @param {connect}
 *            [options.connect] Optional Connect middleware object
 * @param {runQMLResponse}
 *            [callback]
 */
function runQML(manifestPath, options, callback) {
  callback = callback || function(error) {
    if (error) {
      console.error(error);
    }
  };

  options = options || {};
  var freeboxAddress = options.freeboxAddress;
  if (!freeboxAddress) {
    searchFreebox(options.searchTimeout, 1, function(error, fbxs) {
      if (!fbxs || !fbxs.length) {
        return callback(new Error("Can not find a freebox"));
      }

      options.freeboxAddress = fbxs[0].freeboxAddress;
      options.interfaceAddress = fbxs[0].interfaceAddress;

      setImmediate(runQML.bind(this, manifestPath, options, callback));
    });
    return;
  }

  var entryPoint = options.entryPoint;

  if (options.url) {
    var url = options.url;
    var reg = /^(.+)manifest\.json$/i.exec(url);
    if (reg) {
      url = reg[1];
    }
    reg = /^(.+)\/$/.exec(url);
    if (reg) {
      url = reg[1];
    }

    sendRequest(url + "/manifest.json", !!options.wait, freeboxAddress,
        entryPoint, callback);
    return;
  }

  function configureConnect(app, server, serverCreated) {
    var interfaceAddress = options.interfaceAddress || server.address().address;
    debug("Connect freeboxHostName=", freeboxAddress, " interfaceAddress=",
        interfaceAddress);

    var reg = /^(.+)manifest\.json$/i.exec(manifestPath);
    if (reg) {
      manifestPath = reg[1];
    }

    if (debug.enabled) {
      var logger = function(request, response, next) {
        debug("Request: " + request.url);
        next();
      };

      app.use(logger);
    }

    app.use(serveStatic(manifestPath), {
      index : false
    });

    var myHostname = interfaceAddress + ":" + server.address().port;
    debug("myHostname=", myHostname);

    sendRequest("http://" + myHostname + "/manifest.json", !!options.wait,
        freeboxAddress, entryPoint, function(error) {
          if (error) {
            if (serverCreated) {
              server.stop();
              server = null;
            }

            return callback(error);
          }

          callback(null, {
            close : function(callback) {
              if (!serverCreated) {
                return callback();
              }
              server.close(callback);
            }
          });
        });

  }

  var server = options.server;
  var app = options.connect;
  if (!server) {
    if (!app) {
      app = connect();
    }
    server = http.createServer(app);
    server.listen(configureConnect.bind(app, app, server, true));
    return;
  }

  if (!app) {
    app = connect();

    server.add('request', app);
  }

  configureConnect(app, server, false);
}

module.exports = {
  search : searchFreebox,
  run : runQML
};
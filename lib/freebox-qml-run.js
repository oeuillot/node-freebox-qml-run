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
 *            programPath Path to the manifest.json (without manifest.json)
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
 * @param {runQMLResponse}
 *            [callback]
 */
function runQML(programPath, options, callback) {
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

      setImmediate(runQML.bind(this, programPath, options, callback));
    });
    return;
  }

  var interfaceAddress = options.interfaceAddress;
  debug("Connect freeboxHostName=", freeboxAddress, " interfaceAddress=",
      interfaceAddress);

  var server = http.createServer(function(request, response) {
    debug("Request=", request.url);

    if (options.filterFunc && options.filterFunc(request, response) === false) {
      return;
    }

    var path = URL.parse(request.url).pathname;

    var p = Path.join(programPath, path);

    send(request, p).pipe(response);
  });

  if (!interfaceAddress) {
    interfaceAddress = myLocalIp();
  }

  server.listen(0, interfaceAddress, function(error) {
    if (error) {
      debug("Can not listen", error);
      return callback(error);
    }

    var myHostname = server.address().address + ":" + server.address().port;
    debug("myHostname=", myHostname);

    var json = {
      id : "0",
      jsonrpc : "2.0",
      method : "debug_qml_app",
      params : {
        entry_point : "main",
        manifest_url : "http://" + myHostname + "/manifest.json",
        wait : !!options.wait
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

        server.close(function() {
          callback(error);
        });
        return;
      }

      debug("Freebox response=", response, body);

      if (body && body.error) {
        var errorJson = new Error("JSONRPC error: " + body.error.message);
        errorJson.jsonCode = body.error.code;

        server.close(function() {
          callback(errorJson);
        });
        return;
      }

      callback(null, {
        close : function(callback) {
          if (!server) {
            return callback();
          }
          server.close(callback);
          server = null;
        }
      });
    });
  });

}

module.exports = {
  search : searchFreebox,
  runQML : runQML
};
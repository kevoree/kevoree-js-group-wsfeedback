// Created by leiko on 02/10/14 12:20
var Class = require('pseudoclass');
var WebSocket = require('ws');
var shortid = require('shortid');
var StringDecoder = require('string_decoder').StringDecoder;
var kevoree = require('kevoree-library').org.kevoree;
var KevScript = require('kevoree-kevscript');

var Protocol = require('./Protocol');
var PushMessage = require('./message/PushMessage');
var PullMessage = require('./message/PullMessage');

var decoder = new StringDecoder('utf8');

/**
 * Handles client events on the WebSocket server
 *  - connection
 *  - messages
 *  - disconnection
 * @type {ClientHandler}
 */
var ClientHandler = Class({
  toString: 'ClientHandler',

  construct: function(group) {
    this.group = group;
    // cache maps
    this.name2Ws = {};
    this.ws2Name = {};
    this.kevs = new KevScript();
  },

  tpl: function(tpl, nodeName) {
    return tpl
      .replace(/{nodeName}/g, nodeName)
      .replace(/{groupName}/g, this.group.getName());
  },

  /**
   * Returns a client handler for WebSocketServer
   * @returns {function(this:ClientHandler)}
   */
  getHandler: function() {
    return function(ws) {
      ws.id = shortid.generate();

      // kevoree tools
      var factory = new kevoree.factory.DefaultKevoreeFactory(),
        loader = factory.createJSONLoader(),
        saver = factory.createJSONSerializer(),
        compare = factory.createModelCompare(),
        cloner = factory.createModelCloner();

      // heartbeat handling
      ws.heartbeatId = setInterval(function() {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
        } else {
          ws.pingId = shortid.generate();
          ws.ping(ws.pingId, null, false);
          ws.pingTimeout = setTimeout(function() {
            ws.close();
          }, 5000);
        }
      }, 5000);
      ws.on('pong', function(data) {
        data = decoder.write(data);
        if (data === ws.pingId) {
          clearTimeout(ws.pingTimeout);
        }
      });

      // broadcast method
      var broadcastModel = function (modelStr) {
        if (this.group.server.clients.length > 0) {
          this.group.log.info(this.group.toString(), 'Broadcasting current model to ' + this.group.server.clients.length + ' client' + ((this.group.server.clients.length > 1) ? 's' : ''));
        }
        this.group.server.clients.forEach(function(client) {
          if (client && client.readyState === WebSocket.OPEN) {
            client.send(modelStr);
          }
        });
      }.bind(this);

      // websocket listeners
      ws.on('close', function() {
        clearInterval(ws.heartbeatId);
        var nodeName = this.ws2Name[ws.id];
        if (nodeName) {
          var modelToApply = cloner.clone(this.group.getKevoreeCore().getCurrentModel());
          var onDisconnectKevs = this.tpl(this.group.getDictionary().getString('onDisconnect', ''), nodeName);
          this.group.log.debug(this.group.toString(), 'onDisconnect KevScript to process:');
          console.log(onDisconnectKevs);
          this.kevs.parse(onDisconnectKevs, modelToApply, function(err, model) {
            if (err) {
              this.group.log.error(this.toString(), 'Unable to parse onDisconnect KevScript. No changes made after the disconnection of ' + nodeName);
            broadcastModel((new PushMessage(saver.serialize(modelToApply))).toRaw());
            this.group.getKevoreeCore().deploy(modelToApply);
          } else {
            broadcastModel((new PushMessage(saver.serialize(model))).toRaw());
            this.group.getKevoreeCore().deploy(model);
            }
          }.bind(this));
        }
        delete this.name2Ws[this.ws2Name[ws.id]];
        delete this.ws2Name[ws.id];
      }.bind(this));

      ws.on('error', function() {
        clearInterval(ws.heartbeatId);
        try {
          ws.close();
        } catch (err) {
          this.group.log.error(this.group.toString(), err.stack);
        }

        if (this.ws2Name !== null) {
          if (this.ws2Name[ws.id] !== null) {
            delete this.name2Ws[this.ws2Name[ws.id]];
          }
          delete this.ws2Name[ws.id];
        }
      }.bind(this));

      ws.on('message', function(msg) {
        var parsedMsg = Protocol.parse(msg);
        if (parsedMsg === null) {
          this.group.log.error(this.group.toString(), '"' + this.group.getName() + '" unknown Kevoree message ' + msg);
        } else {
          switch (parsedMsg.getType()) {
            case Protocol.REGISTER_TYPE:
              if (!this.name2Ws[parsedMsg.getNodeName()]) {
                // cache new client
                this.name2Ws[parsedMsg.getNodeName()] = ws;
                this.ws2Name[ws.id] = parsedMsg.getNodeName();

                if (this.group.isMaster()) {
                  this.group.log.info(this.group.toString(), 'New client registered "' + parsedMsg.getNodeName() + '"');
                  var modelToApply = cloner.clone(this.group.getKevoreeCore().getCurrentModel());
                  if (parsedMsg.getModel() || parsedMsg.getModel() !== 'null') {
                    // new registered model has a model to share: merging it locally
                    var recModel = loader.loadModelFromString(parsedMsg.getModel()).get(0);
                    compare.merge(modelToApply, recModel).applyOn(modelToApply);
                    this.group.log.debug(this.group.toString(), 'Client\'s "'+parsedMsg.getNodeName()+'" model has been merged with the current one');
                  }

                  // add onConnect logic
                  var onConnectKevs = this.tpl(this.group.getDictionary().getString('onConnect', ''), parsedMsg.getNodeName());
                  this.group.log.debug(this.group.toString(), 'onConnect KevScript to process:');
                  console.log(onConnectKevs);
                  this.kevs.parse(onConnectKevs, modelToApply, function(err, model) {
                    if (err) {
                      this.group.log.error(this.toString(), 'Unable to parse onConnect KevScript ('+err.message+'). Broadcasting model without onConnect process.');
                      broadcastModel((new PushMessage(saver.serialize(modelToApply))).toRaw());
                      this.group.getKevoreeCore().deploy(modelToApply);
                    } else {
                      broadcastModel((new PushMessage(saver.serialize(model))).toRaw());
                      this.group.getKevoreeCore().deploy(model);
                    }
                  }.bind(this));
                }
              }
              break;

            case Protocol.PULL_TYPE:
              var modelReturn = saver.serialize(this.group.getKevoreeCore().getCurrentModel());
              ws.send(modelReturn);
              this.group.log.info(this.group.toString(), 'Pull requested');
              break;

            case Protocol.PUSH_TYPE:
              var model = loader.loadModelFromString(parsedMsg.getModel()).get(0);
              this.group.log.info(this.group.toString(), 'Push received');
              if (this.group.hasMaster()) {
                if (this.group.isMaster()) {
                  broadcastModel(parsedMsg.toRaw());
                }
              } else {
                this.group.log.info(this.group.toString(), 'No master specified, model will NOT be send to all other nodes');
              }
              this.group.log.info(this.group.toString(), 'Applying model locally...');
              this.group.getKevoreeCore().deploy(model);

              break;

            default:
              this.group.log.error(this.group.toString(), '"' + this.group.getName() + '" unhandled Kevoree message ' + msg);
              break;
          }
        }
      }.bind(this));
    }.bind(this);
  },

  /**
   * Clear server caches
   */
  clearCache: function() {
    Object.keys(this.name2Ws).forEach(function(name) {
      delete this.name2Ws[name];
    }.bind(this));

    Object.keys(this.ws2Name).forEach(function(wsId) {
      delete this.ws2Name[wsId];
    }.bind(this));
  }
});

module.exports = ClientHandler;

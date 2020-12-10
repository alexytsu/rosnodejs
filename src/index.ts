/*
 *    Copyright 2016 Rethink Robotics
 *
 *    Copyright 2016 Chris Smith
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

//------------------------------------------------------------------

import * as netUtils from './utils/network_utils';
import * as msgUtils from './utils/message_utils';
import * as OnTheFlyMessages from './utils/messageGeneration/OnTheFlyMessages';
import * as util from 'util';
import * as fs from 'fs';
import RosLogStream from './utils/log/RosLogStream';
import ConsoleLogStream from './utils/log/ConsoleLogStream';
import RosNode, { NodeOptions } from './lib/RosNode';
import NodeHandle from './lib/NodeHandle';
import LoggingManager, { NodeLoggerOptions, RosLoggerOptions } from './lib/LoggingManager';
import Time from './lib/Time';
import * as packages from './utils/messageGeneration/packages';

import ActionServer from './actions/ActionServer';
import ActionClient from './actions/ActionClient';
import * as ClientStates from './actions/ClientStates';
import SimpleActionClient from './actions/SimpleActionClient';
import SimpleActionServer from './actions/SimpleActionServer';

import MsgLoader from './utils/messageGeneration/MessageManager';
import * as RemapUtils from './utils/remapping_utils';
import names from './lib/Names';
import ThisNode from './lib/ThisNode';
import type { ActionClientInterfaceOptions } from './lib/ActionClientInterface';
import { fstat } from 'fs';

// will be initialized through call to initNode
let log = LoggingManager.getLogger();

//------------------------------------------------------------------

const Rosnodejs = {
  /**
   * Initializes a ros node for this process. Only one ros node can exist per process.
   * If called a second time with the same nodeName, returns a handle to that node.
   * @param {string} nodeName name of the node to initialize
   * @param {object} options  overrides for this node
   * @param {boolean}   options.anonymous Set node to be anonymous
   * @param {object}    options.logging logger options for this node
   * @param {function}  options.logging.getLoggers  the function for setting which loggers
   *                                                to be used for this node
   * @param {function}  options.logging.setLoggerLevel  the function for setting the logger
   *                                                    level
   * @param {string}    options.rosMasterUri the Master URI to use for this node
   * @param {number}    options.timeout time in ms to wait for node to be initialized
   *                                    before timing out. A negative value will retry forever.
   *                                    A value of '0' will try once before stopping. @default -1
   * @return {Promise} resolved when connection to master is established
   */
  async initNode(nodeName: string, options?: InitNodeOptions): Promise<NodeHandle> {
    if (typeof nodeName !== 'string') {
      throw new Error('The node name must be a string');
    }
    else if (nodeName.length === 0) {
      throw new Error('The node name must not be empty!');
    }

    options = options || {};

    // process remappings from command line arguments.
    // First two are $ node <file> so we skip them
    const remappings = RemapUtils.processRemapping(process.argv.slice(2));

    // initialize netUtils from possible command line remappings
    netUtils.init(remappings);

    const [resolvedName, namespace] = _resolveNodeName(nodeName, remappings, options);

    names.init(remappings, namespace);

    if (ThisNode.node !== null) {
      if (resolvedName === ThisNode.getNodeName()) {
        return this.getNodeHandle();
      }
      // else
      return Promise.reject( Error('Unable to initialize node [' + resolvedName + '] - node ['
                      + ThisNode.getNodeName() + '] already exists'));
    }

    LoggingManager.initializeNodeLogger(resolvedName, options.logging);

    // create the ros node. Return a promise that will
    // resolve when connection to master is established
    const nodeOpts = options.node || {};
    const rosMasterUri = options.rosMasterUri || remappings['__master'] || process.env.ROS_MASTER_URI;;

    ThisNode.node = new RosNode(resolvedName, rosMasterUri, nodeOpts);

    try {
      await this._loadOnTheFlyMessages(options.onTheFly);
      await waitForMaster(100, options.timeout);
      await LoggingManager.initializeRosOptions(new NodeHandle(ThisNode.node), options.logging);
      await Time._initializeRosTime(this, options.notime);
      return this.getNodeHandle();
    }
    catch(err) {
      log.error('Error during initialization: ' + err);
      if (this.ok()) {
        await this.shutdown();
      }
      throw err;
    }
  },

  reset() {
    ThisNode.node = null;
  },

  shutdown() {
    return ThisNode.shutdown();
  },

  ok() {
    return ThisNode.ok();
  },

  on<T extends any[]>(evt: string, handler:(...args: T)=>void): void {
    if (ThisNode.node) {
      ThisNode.node.on(evt, handler);
    }
  },

  once<T extends any[]>(evt: string, handler:(...args: T)=>void): void {
    if (ThisNode.node) {
      ThisNode.node.once(evt, handler);
    }
  },

  removeListener<T extends any[]>(evt: string, handler:(...args: T)=>void): void {
    if (ThisNode.node) {
      ThisNode.node.removeListener(evt, handler);
    }
  },

  async _loadOnTheFlyMessages(onTheFly: boolean): Promise<void> {
    if (onTheFly) {
      return OnTheFlyMessages.getAll();
    }
  },

  async generateMessages(options: GenerateMessageOptions): Promise<void> {
    const msgLoader = new MsgLoader(options.verbose || false);
    if (!options.outputDir) {
      options.outputDir = msgUtils.getTopLevelMessageDirectory();
    }
    if (options.package) {
      await msgLoader.buildPackage(options.package, options.outputDir);
    }
    else {
      await msgLoader.buildPackageTree(options.outputDir);
    }

    if (options.generateTypes) {
      await msgLoader.generateTypes(options.outputDir);
    }
  },

  findPackage(packageName: string): Promise<string> {
    return packages.findPackage(packageName);
  },

  require(msgPackage: string) {
    return msgUtils.requireMsgPackage(msgPackage);
  },

  getAvailableMessagePackages() {
    return msgUtils.getAvailableMessagePackages();
  },

  /** check that a message definition is loaded for a ros message
      type, e.g., geometry_msgs/Twist */
  checkMessage<T = any>(type: string): T {
    const parts = type.split('/');
    let rtv;
    try {
      rtv = this.require(parts[0]).msg[parts[1]];
    } catch(e) {}
    return rtv;
  },

  /** check that a service definition is loaded for a ros service
      type, e.g., turtlesim/TeleportRelative */
  checkService<T = any>(type: string): T {
    const parts = type.split('/');
    let rtv;
    try {
      rtv = this.require(parts[0]).srv[parts[1]];
    } catch(e) {}
    return rtv;
  },

  /**
   * @return {NodeHandle} for initialized node
   */
  getNodeHandle(namespace?: string): NodeHandle {
    return new NodeHandle(ThisNode.node, namespace);
  },

  get nodeHandle(): NodeHandle {
    return new NodeHandle(ThisNode.node);
  },

  get nh(): NodeHandle {
    return new NodeHandle(ThisNode.node);
  },

  get log() {
    return LoggingManager;
  },

  get logStreams() {
    return {
      console: ConsoleLogStream,
      ros:     RosLogStream
    }
  },

  get Time() {
    return Time;
  },

  //------------------------------------------------------------------
  // ActionLib
  //------------------------------------------------------------------

  /**
    Get an action client for a given type and action server.

    **Deprecated**: Use rosNode.nh.actionClientInterface instead.

    Example:
      let ac = rosNode.nh.getActionClient(
        "/turtle_shape", "turtle_actionlib/ShapeAction");
      let shapeActionGoal =
        rosnodejs.require('turtle_actionlib').msg.ShapeActionGoal;
      ac.sendGoal(new shapeActionGoal({ goal: { edges: 3,  radius: 1 } }));
   */
  getActionClient(options: Omit<ActionClientInterfaceOptions, 'nh'>) {
    return this.nh.actionClientInterface(
      options.actionServer, options.type, options);
  },

  ActionServer,
  ActionClient,
  SimpleActionServer,
  SimpleActionClient,
  SimpleClientGoalState: ClientStates.SimpleClientGoalState
};

export default Rosnodejs;
export type { default as Subscriber } from './lib/Subscriber';
export type { default as Publisher } from './lib/Publisher';
export type { default as ServiceClient } from './lib/ServiceClient';
export type { default as ServiceServer } from './lib/ServiceServer';



//------------------------------------------------------------------
// Local Helper Functions
//------------------------------------------------------------------

/**
 * @private
 * Helper function to see if the master is available and able to accept
 * connections.
 * @param {number} timeout time in ms between connection attempts
 * @param {number} maxTimeout maximum time in ms to retry before timing out.
 * A negative number will make it retry forever. 0 will only make one attempt
 * before timing out.
 */
async function waitForMaster(timeout=100, maxTimeout=-1): Promise<void> {
  const startTime = Date.now();
  await sleep(timeout);
  while (ThisNode.ok() && !ThisNode.node.serversReady()) {
    if (maxTimeout >= 0 && Date.now() - startTime >= maxTimeout) {
      log.error(`Unable to register with master node [${ThisNode.node.getRosMasterUri()}]: unable to set up slave API Server. Stopping...`);
      throw new Error('Unable to setup slave API server.');
    }
    await sleep(timeout);
  }

  while (ThisNode.ok()) {
    try {
      await ThisNode.node.getMasterUri({ maxAttempts: 1 });
      log.info(`Connected to master at ${ThisNode.node.getRosMasterUri()}!`);
      break;
    }
    catch(err) {
      if (ThisNode.ok()) {
        if (maxTimeout >= 0 && Date.now() - startTime >= maxTimeout){
          log.error(`Timed out before registering with master node [${ThisNode.node.getRosMasterUri()}]: master may not be running yet.`);
          throw new Error('Registration with master timed out.');
        } else {
          log.warnThrottle(60000, `Unable to register with master node [${ThisNode.node.getRosMasterUri()}]: master may not be running yet. Will keep trying.`);
          await sleep(timeout);
        }
      }
      else {
        log.warn(`Shutdown while trying to register with master node`);
        throw new Error('Shutdown during initialization');
      }
    }
  }

  if (!ThisNode.ok()) {
    log.warn(`Shutdown while trying to register with master node`);
    throw new Error('Shutdown during initialization');
  }
}

function sleep(timeout: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

function _resolveNodeName(nodeName: string, remappings: RemapUtils.RemapT, options: any): [string, string] {
  let namespace = remappings['__ns'] || process.env.ROS_NAMESPACE || '';
  namespace = names.clean(namespace);
  if (namespace.length === 0 || !namespace.startsWith('/')) {
    namespace = `/${namespace}`;
  }

  names.validate(namespace, true);

  nodeName = remappings['__name'] || nodeName;
  nodeName = names.resolve(namespace, nodeName);

  // only anonymize node name if they didn't remap from the command line
  if (options.anonymous && !remappings['__name']) {
    nodeName = _anonymizeNodeName(nodeName);
  }

  return [nodeName, namespace]
}

/**
 * Appends a random string of numeric characters to the end
 * of the node name. Follows rospy logic.
 * @param nodeName {string} string to anonymize
 * @return {string} anonymized nodeName
 */
function _anonymizeNodeName(nodeName: string): string {
  return util.format('%s_%s_%s', nodeName, process.pid, Date.now());
}

interface InitNodeOptions {
  anonymous?: boolean;
  logging?: NodeLoggerOptions & RosLoggerOptions,
  rosMasterUri?: string;
  timeout?: number;
  node?: NodeOptions; // FIXME
  onTheFly?: boolean;
  notime?: boolean;
}

interface GenerateMessageOptions {
  verbose?: boolean;
  outputDir?: string;
  package?: string;
  generateTypes?: boolean;
}
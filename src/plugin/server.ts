/**
 * gRPC server implementation for Criteria adapter plugins.
 * 
 * This module implements the server-side of the go-plugin protocol,
 * handling the gRPC communication between the Criteria host and the plugin.
 */

import './long-polyfill.js';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { INamespace } from 'protobufjs';
import type { AdapterService, EventSender } from './types.js';
import protoJson from '../proto/criteria/v1/adapter_plugin.json' assert { type: 'json' };
import type {
  InfoRequest,
  InfoResponse,
  OpenSessionRequest,
  OpenSessionResponse,
  ExecuteRequest,
  PermitRequest,
  PermitResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  ExecuteEvent,
} from '../proto/criteria/v1/adapter_plugin.js';


/**
 * Internal implementation of EventSender for streaming events.
 */
class EventSenderImpl implements EventSender {
  private call: grpc.ServerWritableStream<ExecuteRequest, ExecuteEvent>;
  private hasSentResult = false;

  constructor(call: grpc.ServerWritableStream<ExecuteRequest, ExecuteEvent>) {
    this.call = call;
  }

  async log(stream: 'stdout' | 'stderr', chunk: string | Uint8Array): Promise<void> {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    
    const event: ExecuteEvent = {
      log: {
        stream: stream.toUpperCase(),
        chunk: buffer,
      },
    };
    
    this.call.write(event);
  }

  async adapterEvent(event: unknown): Promise<void> {
    const executeEvent: ExecuteEvent = {
      adapter: event,
    };
    this.call.write(executeEvent);
  }

  async permissionRequest(permission: string, details: Record<string, string>): Promise<string> {
    const id = `perm-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    const event: ExecuteEvent = {
      permission: {
        id,
        permission,
        details,
      },
    };
    
    this.call.write(event);
    return id;
  }

  async result(outcome: string, outputs: Record<string, string>): Promise<void> {
    if (this.hasSentResult) {
      throw new Error('Result already sent');
    }
    
    this.hasSentResult = true;
    
    const event: ExecuteEvent = {
      result: {
        outcome,
        outputs,
      },
    };
    
    this.call.write(event);
    this.call.end();
  }

  hasResult(): boolean {
    return this.hasSentResult;
  }
}

/**
 * Server options for the gRPC server.
 */
export interface ServerOptions {
  /** 
   * Network address to listen on.
   * Default: inherited from go-plugin (via PLUGIN_MIN_PORT, PLUGIN_MAX_PORT)
   */
  address?: string;
  
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Load the proto definition and create service implementation.
 */
function loadProtoService(): grpc.GrpcObject {
  const packageDefinition = protoLoader.fromJSON(protoJson as INamespace, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  return grpc.loadPackageDefinition(packageDefinition);
}

/**
 * Create the gRPC service implementation from an adapter service.
 */
function createServiceImplementation(service: AdapterService): grpc.UntypedServiceImplementation {
  return {
    // Info - unary RPC
    Info: (_call: grpc.ServerUnaryCall<InfoRequest, InfoResponse>, callback: grpc.sendUnaryData<InfoResponse>) => {
      service.info()
        .then((response) => callback(null, response))
        .catch((err) => callback(err as Error));
    },

    // OpenSession - unary RPC
    OpenSession: (call: grpc.ServerUnaryCall<OpenSessionRequest, OpenSessionResponse>, callback: grpc.sendUnaryData<OpenSessionResponse>) => {
      const req = call.request;
      service.openSession(req)
        .then((response) => callback(null, response))
        .catch((err) => callback(err as Error));
    },

    // Execute - server streaming RPC
    Execute: (call: grpc.ServerWritableStream<ExecuteRequest, ExecuteEvent>) => {
      const req = call.request;
      const sender = new EventSenderImpl(call);

      service.execute(req, sender)
        .then(() => {
          if (!sender.hasResult()) {
            call.emit('error', new Error('Execute completed without sending result'));
          }
        })
        .catch((err) => {
          call.emit('error', err);
        });
    },

    // Permit - unary RPC
    Permit: (call: grpc.ServerUnaryCall<PermitRequest, PermitResponse>, callback: grpc.sendUnaryData<PermitResponse>) => {
      const req = call.request;
      service.permit(req)
        .then((response) => callback(null, response))
        .catch((err) => callback(err as Error));
    },

    // CloseSession - unary RPC
    CloseSession: (call: grpc.ServerUnaryCall<CloseSessionRequest, CloseSessionResponse>, callback: grpc.sendUnaryData<CloseSessionResponse>) => {
      const req = call.request;
      service.closeSession(req)
        .then((response) => callback(null, response))
        .catch((err) => callback(err as Error));
    },
  };
}

/**
 * Start the gRPC server for an adapter service.
 * 
 * This function creates and starts a gRPC server implementing the
 * AdapterPluginService interface. It reads the connection configuration
 * from environment variables set by the go-plugin host.
 * 
 * @param service - The adapter service implementation
 * @param options - Server configuration options
 * @returns Promise that resolves when server is ready
 */
export function startServer(service: AdapterService, options: ServerOptions = {}): Promise<grpc.Server> {
  return new Promise((resolve, reject) => {
    // go-plugin sets these environment variables
    const tcpPort = process.env['PLUGIN_TCP_PORT'];
    const unixSocket = process.env['PLUGIN_UNIX_SOCKET'];
    
    const server = new grpc.Server();
    
    try {
      // Load proto and create service
      const protoDescriptor = loadProtoService();
      const criteriaPkg = protoDescriptor.criteria as grpc.GrpcObject | undefined;
      const v1Pkg = criteriaPkg?.v1 as grpc.GrpcObject | undefined;
      const serviceCtor = (v1Pkg?.AdapterPluginService || protoDescriptor.AdapterPluginService) as grpc.ServiceClientConstructor | undefined;
      const serviceDef = serviceCtor?.service;

      if (!serviceDef) {
        // Fallback: Define service manually if proto loading fails
        const manualServiceDef: grpc.ServiceDefinition = {
          Info: {
            path: '/criteria.v1.AdapterPluginService/Info',
            requestStream: false,
            responseStream: false,
            requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
            responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          },
          OpenSession: {
            path: '/criteria.v1.AdapterPluginService/OpenSession',
            requestStream: false,
            responseStream: false,
            requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
            responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          },
          Execute: {
            path: '/criteria.v1.AdapterPluginService/Execute',
            requestStream: false,
            responseStream: true,
            requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
            responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          },
          Permit: {
            path: '/criteria.v1.AdapterPluginService/Permit',
            requestStream: false,
            responseStream: false,
            requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
            responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          },
          CloseSession: {
            path: '/criteria.v1.AdapterPluginService/CloseSession',
            requestStream: false,
            responseStream: false,
            requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
            responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)),
            responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          },
        };
        server.addService(manualServiceDef, createServiceImplementation(service));
      } else {
        server.addService(serviceDef, createServiceImplementation(service));
      }
    } catch (err) {
      reject(err);
      return;
    }
    
    // Determine bind address
    let bindAddress: string;
    
    if (unixSocket) {
      // Unix socket is preferred for local communication
      bindAddress = `unix:${unixSocket}`;
    } else if (tcpPort) {
      // TCP fallback
      bindAddress = `0.0.0.0:${tcpPort}`;
    } else if (options.address) {
      // User-specified address
      bindAddress = options.address;
    } else {
      // Default to stdio for testing
      bindAddress = '127.0.0.1:50051';
    }
    
    server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (options.debug) {
        console.error(`gRPC server listening on ${bindAddress} (port ${port})`);
      }
      
      // go-plugin expects the port on stdout for TCP connections
      if (tcpPort && !unixSocket) {
        console.log(port);
      }
      
      resolve(server);
    });
  });
}

/**
 * Stop the gRPC server.
 * 
 * @param server - The gRPC server instance
 * @returns Promise that resolves when server is stopped
 */
export function stopServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => {
    server.tryShutdown(() => {
      resolve();
    });
  });
}

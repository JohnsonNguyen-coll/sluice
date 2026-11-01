import { x402Facilitator } from "@x402/core/facilitator";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPResponseInstructions,
} from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner, type AuthorizerSigner } from "@x402/evm";
import { BatchSettlementEvmScheme as BatchFacilitatorScheme } from "@x402/evm/batch-settlement/facilitator";
import {
  type BatchSettlementChannelManager,
  BatchSettlementEvmScheme as BatchServerScheme,
} from "@x402/evm/batch-settlement/server";
import { FileChannelStorage } from "@x402/evm/batch-settlement/server/file-storage";
import type { Address } from "viem";
import { join } from "node:path";
import { FilePendingSettlementStore } from "./x402-pending-store";

type FacilitatorSignerInput = Parameters<typeof toFacilitatorEvmSigner>[0];

class LocalFacilitatorClient implements FacilitatorClient {
  constructor(private readonly facilitator: x402Facilitator) {}

  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  async getSupported(): Promise<SupportedResponse> {
    return this.facilitator.getSupported() as SupportedResponse;
  }
}

function adapter(req: Request, parsedBody: unknown): HTTPAdapter {
  const url = new URL(req.url);
  return {
    getHeader: (name) => req.headers.get(name) || undefined,
    getMethod: () => req.method,
    getPath: () => url.pathname,
    getUrl: () => url.href,
    getAcceptHeader: () => req.headers.get("accept") || "application/json",
    getUserAgent: () => req.headers.get("user-agent") || "",
    getQueryParams: () => Object.fromEntries(url.searchParams),
    getQueryParam: (name) => url.searchParams.getAll(name),
    getBody: () => parsedBody,
  };
}

function instructionResponse(instructions: HTTPResponseInstructions) {
  const headers = new Headers(instructions.headers);
  if (instructions.body === undefined)
    return new Response(null, { status: instructions.status, headers });
  if (typeof instructions.body === "string")
    return new Response(instructions.body, {
      status: instructions.status,
      headers,
    });
  if (!headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(instructions.body), {
    status: instructions.status,
    headers,
  });
}

export type X402GatewayOptions = {
  network: `eip155:${number}`;
  receiver: Address;
  token: Address;
  price: string;
  resourceUrl: string;
  serviceName: string;
  storageDirectory: string;
  facilitatorSigner: FacilitatorSignerInput;
  receiverAuthorizerSigner: AuthorizerSigner;
};

/**
 * A self-contained x402 v2 batch-settlement resource server for one hosted API.
 * The local facilitator submits Arc transactions with the managed provider key;
 * channel and pending-deposit state are persisted on the same volume.
 */
export class X402Gateway {
  private constructor(
    private readonly server: x402HTTPResourceServer,
    private readonly resourceUrl: string,
    private readonly manager: BatchSettlementChannelManager,
  ) {}

  static async create(options: X402GatewayOptions) {
    const tenCalls = BigInt(options.price) * 10n;
    const minDeposit = (tenCalls > 1_000_000n ? 1_000_000n : tenCalls).toString();
    const facilitatorSigner = toFacilitatorEvmSigner(
      options.facilitatorSigner,
      { confirmationTimeoutMs: 45_000 },
    );
    const facilitator = new x402Facilitator().register(
      options.network,
      new BatchFacilitatorScheme(facilitatorSigner, undefined, {
        pendingSettlementStore: new FilePendingSettlementStore(
          join(options.storageDirectory, "pending-deposits"),
        ),
      }),
    );
    const client = new LocalFacilitatorClient(facilitator);
    const scheme = new BatchServerScheme(options.receiver, {
      storage: new FileChannelStorage({ directory: options.storageDirectory }),
      receiverAuthorizerSigner: options.receiverAuthorizerSigner,
      enforceMinDeposit: true,
    });
    const resource = new x402ResourceServer(client).register(
      options.network,
      scheme,
    );
    const http = new x402HTTPResourceServer(resource, {
      [`POST ${new URL(options.resourceUrl).pathname}`]: {
        accepts: {
          scheme: "batch-settlement",
          network: options.network,
          payTo: options.receiver,
          price: {
            asset: options.token,
            amount: options.price,
            extra: { name: "USDC", version: "2" },
          },
          maxTimeoutSeconds: 300,
          // Keep the batch useful without asking a client to lock an unbounded
          // amount: ten calls, capped at 1 USDC for this managed API.
          extra: { minDeposit },
        },
        resource: options.resourceUrl,
        description: `${options.serviceName} paid API`,
        serviceName: options.serviceName,
        mimeType: "application/json",
        unpaidResponseBody: async () => ({
          contentType: "application/json",
          body: {
            error: "PAYMENT_REQUIRED",
            message: "Retry with a valid x402 PAYMENT-SIGNATURE header.",
          },
        }),
        settlementFailedResponseBody: async () => ({
          contentType: "application/json",
          body: {
            error: "PAYMENT_NOT_COMMITTED",
            message: "The result was withheld because payment could not be recorded.",
          },
        }),
      },
    });
    await http.initialize();
    return new X402Gateway(
      http,
      options.resourceUrl,
      scheme.createChannelManager(client, options.network, options.token),
    );
  }

  async hasClaimableVouchers() {
    return (await this.manager.getClaimableVouchers()).length > 0;
  }

  async claimAndSettle() {
    const result = await this.manager.claimAndSettle({ maxClaimsPerBatch: 100 });
    return [
      ...result.claims.map((claim) => claim.transaction),
      ...(result.settle ? [result.settle.transaction] : []),
    ];
  }

  async handle(
    req: Request,
    parsedBody: unknown,
    handler: () => Promise<Response>,
  ): Promise<Response> {
    const requestAdapter = adapter(req, parsedBody);
    const context = {
      adapter: requestAdapter,
      path: new URL(req.url).pathname,
      method: req.method,
      paymentHeader: req.headers.get("payment-signature") || undefined,
    };
    const payment = await this.server.processHTTPRequest(context, {
      appName: "Sluice",
      currentUrl: this.resourceUrl,
      testnet: true,
    });
    if (payment.type === "payment-error")
      return instructionResponse(payment.response);
    if (payment.type !== "payment-verified")
      return Response.json(
        { error: "PAYMENT_REQUIRED", message: "This route requires x402 payment." },
        { status: 402 },
      );

    let result: Response;
    try {
      result = await handler();
    } catch (error) {
      await payment.cancellationDispatcher.cancel({
        reason: "handler_threw",
        error,
      });
      throw error;
    }
    if (!result.ok) {
      const canceled = await payment.cancellationDispatcher.cancel({
        reason: "handler_failed",
        responseStatus: result.status,
      });
      const headers = new Headers(result.headers);
      if (canceled)
        Object.entries(this.server.createSettlementHeaders(canceled)).forEach(
          ([key, value]) => headers.set(key, value),
        );
      headers.set("Cache-Control", "no-store, private");
      return new Response(result.body, { status: result.status, headers });
    }

    const responseBody = Buffer.from(await result.clone().arrayBuffer());
    const responseHeaders = Object.fromEntries(result.headers.entries());
    const settlement = await this.server.processSettlement(
      payment.paymentPayload,
      payment.paymentRequirements,
      payment.declaredExtensions,
      {
        request: context,
        responseBody,
        responseHeaders,
      },
      undefined,
      payment.beforeHandlerSettlement,
    );
    if (!settlement.success)
      return instructionResponse(settlement.response);

    const headers = new Headers(result.headers);
    Object.entries(settlement.headers).forEach(([key, value]) =>
      headers.set(key, value),
    );
    headers.set("Cache-Control", "no-store, private");
    return new Response(result.body, { status: result.status, headers });
  }
}

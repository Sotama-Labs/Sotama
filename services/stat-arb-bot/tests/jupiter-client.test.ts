import { expect } from "chai";
import { JupiterClient } from "../src/jupiter-client";

describe("JupiterClient execution requests", () => {
  it("requests a taker-bound order transaction", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const client = new JupiterClient({
      baseUrl: "https://api.jup.ag",
      apiKey: "key",
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers;
        return new Response(
          JSON.stringify({
            inAmount: "100",
            outAmount: "95",
            transaction: "base64-tx",
            requestId: "req-1",
            lastValidBlockHeight: "123",
            router: "iris",
            priceImpact: 0.001,
          }),
          { status: 200 },
        );
      },
    });

    const result = await client.order({
      inputMint: "in",
      outputMint: "out",
      amount: 100n,
      slippageBps: 50,
      taker: "taker",
      excludeRouters: "jupiterz",
    });

    expect(capturedUrl).to.contain("/swap/v2/order?");
    expect(capturedUrl).to.contain("taker=taker");
    expect(capturedUrl).to.contain("excludeRouters=jupiterz");
    expect((capturedHeaders as Record<string, string>)["x-api-key"]).to.equal("key");
    expect(result.status).to.equal("ok");
    if (result.status === "ok") {
      expect(result.transaction).to.equal("base64-tx");
      expect(result.requestId).to.equal("req-1");
      expect(result.lastValidBlockHeight).to.equal("123");
    }
  });

  it("posts signed transactions to Jupiter execute", async () => {
    let capturedBody: any;
    const client = new JupiterClient({
      baseUrl: "https://api.jup.ag",
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            status: "Success",
            signature: "sig",
            outputAmountResult: "90",
            code: 0,
          }),
          { status: 200 },
        );
      },
    });

    const result = await client.execute({
      signedTransaction: "signed",
      requestId: "req-1",
      lastValidBlockHeight: "123",
    });

    expect(capturedBody).to.deep.equal({
      signedTransaction: "signed",
      requestId: "req-1",
      lastValidBlockHeight: "123",
    });
    expect(result.status).to.equal("ok");
    if (result.status === "ok") {
      expect(result.swapStatus).to.equal("Success");
      expect(result.signature).to.equal("sig");
      expect(result.outputAmountResult).to.equal(90n);
    }
  });
});

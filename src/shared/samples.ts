// Realistic sample inputs, used by the UI's "try a sample" buttons and by tests.

export const SAMPLES = {
  environmentFailure: `Run npm ci
npm ERR! code ETIMEDOUT
npm ERR! errno ETIMEDOUT
npm ERR! network request to https://registry.npmjs.org/@types%2fnode failed, reason: connect ETIMEDOUT 104.16.27.34:443
npm ERR! network This is a problem related to network connectivity.
npm ERR! A complete log of this run can be found in: /home/runner/.npm/_logs/2026-10-21T14_02_11_123Z-debug-0.log
Error: Process completed with exit code 1.`,

  changeFailure: `> checkout-api@2.14.0 test
> vitest run

 FAIL  src/cart/totals.test.ts > applies percentage discount
AssertionError: expected 90.00000000000001 to be 90
 ❯ src/cart/totals.test.ts:42:31
     40|   const cart = buildCart([{ sku: "A1", price: 100 }]);
     41|   const total = applyDiscount(cart, { percent: 10 });
     42|   expect(total).toBe(90);

 Test Files  1 failed | 37 passed (38)
      Tests  1 failed | 412 passed (413)
Error: Process completed with exit code 1.`,

  mixedFailure: `Deploying checkout-api:3f9c2ab to prod-us-east
Waiting for rollout: 2 of 6 updated replicas are available...
Warning  BackOff  pod/checkout-api-7d9f  Back-off restarting failed container
pod/checkout-api-7d9f  CrashLoopBackOff
TypeError: Cannot read properties of undefined (reading 'region')
    at loadConfig (/app/dist/config.js:18:27)
error: deployment "checkout-api" exceeded its progress deadline`,

  changeDescription: `Switching checkout-api's payment client from the v1 to the v2 SDK.
Adds retries with backoff and a new idempotency-key header. Touches the
charge and refund paths; behind the flag payments.v2_client.`,
} as const;

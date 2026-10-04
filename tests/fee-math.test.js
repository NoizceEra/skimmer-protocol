// Fee math: skim = output * bps / 10000. Same rule on-chain + keeper + SDK.
function skimFor(output, bps) {
  return (BigInt(output) * BigInt(bps)) / 10000n;
}
function assertEq(a, b, msg) {
  if (a !== b) {
    console.error(`FAIL ${msg}: ${a} !== ${b}`);
    process.exit(1);
  }
  console.log(`ok ${msg}: ${a}`);
}
assertEq(skimFor(1_000_000n, 500).toString(), '50000', '5% of 1M');
assertEq(skimFor(1_000_000n, 40).toString(), '4000', '0.4% fee of 1M');
assertEq(skimFor(0n, 500).toString(), '0', 'dust stays dust');
assertEq(skimFor(100n, 1000).toString(), '10', '10% cap');
console.log('fee-math: all pass');

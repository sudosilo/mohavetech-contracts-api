import { ethers } from "ethers";

const RPC_URL = process.env.CHAIN_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);
const CHAIN_NAME = process.env.CHAIN_NAME || "polygon";
const MIN_TIP = ethers.parseUnits(process.env.MIN_TIP_GWEI || "30", "gwei");

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const wallet = process.env.WALLET_PRIVATE_KEY
  ? new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider)
  : null;

export function chainReady() {
  return wallet !== null;
}

export function chainName() {
  return CHAIN_NAME;
}

export async function walletStatus() {
  if (!wallet) return { ready: false };
  const balance = await provider.getBalance(wallet.address);
  return { ready: true, address: wallet.address, balance: ethers.formatEther(balance) + " POL" };
}

export async function writeHash(docHashHex) {
  if (!wallet) throw new Error("house wallet is not configured");
  const data = ethers.hexlify(ethers.toUtf8Bytes("MTG1")) + docHashHex;

  const [block, fees] = await Promise.all([provider.getBlock("latest"), provider.getFeeData()]);
  let tip = fees.maxPriorityFeePerGas || MIN_TIP;
  if (tip < MIN_TIP) tip = MIN_TIP;
  const maxFee = block.baseFeePerGas * 2n + tip;

  const tx = await wallet.sendTransaction({
    to: wallet.address,
    value: 0n,
    data,
    maxPriorityFeePerGas: tip,
    maxFeePerGas: maxFee,
  });
  const receipt = await tx.wait(1, 180000);
  if (!receipt || receipt.status !== 1) throw new Error("transaction failed on chain");

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasPaid: ethers.formatEther(receipt.gasUsed * receipt.gasPrice) + " POL",
  };
}

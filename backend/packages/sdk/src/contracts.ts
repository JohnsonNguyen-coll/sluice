import type { Abi } from "viem";
import v1 from "./abi/AgentWallet.json";
import v2 from "./abi/AgentWalletV2.json";
import v3 from "./abi/AgentWalletV3.json";
import f1 from "./abi/AgentWalletFactory.json";
import f2 from "./abi/AgentWalletFactoryV2.json";
import f3 from "./abi/AgentWalletFactoryV3.json";
import agent from "./abi/AgentRegistry.json";
import provider from "./abi/ProviderRegistry.json";
import reputation from "./abi/ReputationRegistry.json";
import vault from "./abi/DisputeVault.json";
export const walletAbis = { 1: v1 as Abi, 2: v2 as Abi, 3: v3 as Abi };
export const factoryAbis = { 1: f1 as Abi, 2: f2 as Abi, 3: f3 as Abi };
export const agentAbi = agent as Abi,
  providerAbi = provider as Abi,
  reputationAbi = reputation as Abi,
  vaultAbi = vault as Abi;

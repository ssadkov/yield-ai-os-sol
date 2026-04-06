export type ChatHintState = "unconnected" | "no_vault" | "has_vault";

export interface ChatHint {
  label: string;
  prompt: string;
}

export const CHAT_HINTS: Record<ChatHintState, ChatHint[]> = {
  unconnected: [
    {
      label: "What can AI do?",
      prompt: "What can this AI agent do?",
    },
    {
      label: "Is it safe?",
      prompt: "Why is connecting my wallet safe?",
    },
    {
      label: "How to start?",
      prompt: "How do I get started?",
    }
  ],
  no_vault: [
    {
      label: "Why create a vault?",
      prompt: "Why do I need to create a vault?",
    },
    {
      label: "What are strategies?",
      prompt: "What investment strategies do you offer?",
    },
    {
      label: "Who can withdraw?",
      prompt: "Who has permission to withdraw my funds?",
    }
  ],
  has_vault: [
    {
      label: "Show balances",
      prompt: "Show my vault balances.",
    },
    {
      label: "Explain strategy",
      prompt: "Explain my current vault strategy.",
    },
    {
      label: "Rebalance",
      prompt: "Rebalance my vault according to my current strategy.",
    }
  ],
};

export const KNOWLEDGE_BASE_RULES = `
AI Agent Knowledge Base (Use these facts to answer general user questions, translate if asked in Russian):
- What can the AI do? The AI agent can automatically rebalance a user's portfolio in a secure vault to maximize yield, according to their selected strategy.
- Why is connecting the wallet safe? Connecting a wallet only gives read access to view balances. For actually depositing funds or creating a vault, the user will be asked to explicitly sign a transaction right in their wallet, where they can see the exact amount and the Solana network fee.
- Why create a vault? A vault is a personal secure smart contract. The AI agent only has permission to perform allowed swap actions (trading) inside the vault to rebalance the portfolio. Only the user (the owner) can withdraw funds; the agent has ZERO withdrawal rights.
- How to get started: 1. Connect wallet. 2. Create a vault. 3. Choose a strategy. 4. Deposit USDC.
`;

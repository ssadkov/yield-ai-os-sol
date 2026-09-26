# Yield AI v2 build context

```yaml
build_status:
  devnet_deployed: true
  mainnet_deployed: true
  mainnet_config_initialized: true
  executor_whitelist_code_ready: true
  executor_whitelist_mainnet_deployed: false
  executor_registry_mainnet_initialized: false
  mainnet_program_id: yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih
  deployment_date: 2026-09-26T03:25:59Z
  rpc_provider: Helius
  production_ready: false
```

`mainnet_deployed` и `mainnet_config_initialized` подтверждены finalized on-chain транзакциями. Executor whitelist проверен только локально: текущий Mainnet бинарник не содержит его. Mainnet Safe, пилот с USDC и Production-переключение ещё не выполнены. On-chain байткод SHA-256: `416f7fe873c16873b099e7a75a535f38f61173aeb731a6321cf98373a8489cef`. Подробнее: [Mainnet preflight](../docs/yield-ai-v2-mainnet-preflight.md).

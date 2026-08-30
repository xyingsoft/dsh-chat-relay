import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // 与 dsh-chat 仓库一致：装载测试会真起 HTTP 服务，串行避免端口相互干扰
    fileParallelism: false,
    testTimeout: 20_000,
  },
})

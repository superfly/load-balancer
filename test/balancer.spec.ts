import { expect } from 'chai'
import { _internal, Backend } from "../src/balancer"

async function fakeFetch(req: RequestInfo, init?: RequestInit) {
  return new Response("hi")
}

function healthy() {
  return <Backend>{
    host: `test.${Math.random()}.local:10001`,
    proxy: fakeFetch,
    requestCount: 0,
    statuses: [200, 200, 200],
    lastError: 0,
    healthScore: 1,
    errorCount: 0
  }
}
function unhealthy() {
  const b = healthy()
  b.statuses.push(500, 500, 500)
  b.healthScore = 0.5
  return b
}
describe("balancing", () => {
  describe("backend scoring", () => {
    it("should score healthy backends high", () => {
      const backend = healthy()
      const score = _internal.score(backend)

      expect(score).to.eq(1)
    })

    it("should score unhealthy backends low", () => {
      const backend = unhealthy()
      const score = _internal.score(backend, 0)

      expect(score).to.eq(0.5)
    })


    it("should give less weight to older errors", () => {
      const backend = unhealthy()
      let score = _internal.score(backend, backend.lastError + 999)
      expect(score).to.eq(0.5)

      score = _internal.score(backend, backend.lastError + 2000) // 2s old error
      expect(score).to.eq(0.6)

      score = _internal.score(backend, backend.lastError + 4000) // 4s old error
      expect(score).to.eq(0.85)

      score = _internal.score(backend, backend.lastError + 9000) // 9s old error
      expect(score).to.eq(0.95)
    })
  })

  describe("backend selection", () => {
    it("should choose healthy backends first", () => {
      const h = [healthy(), healthy()]
      const backends = [unhealthy(), unhealthy(), unhealthy()].concat(h)
      const [b1, b2] = _internal.chooseBackends(backends, {})

      expect(h.find((e) => e === b1)).to.eq(b1, "Backend 1 should be in selected")
      expect(h.find((e) => e === b2)).to.eq(b2, "Backend 2 should be in selected")
      expect(b1).to.not.eq(b2, "Backend 1 and Backend 2 should be different")
    })
  })
})
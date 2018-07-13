import proxy, { ProxyOptions } from "@fly/proxy"

export interface BalancerOptions extends ProxyOptions {
  healthURL?: string | URL
}
const proxyError = new Response("couldn't connect to origin", { status: 502 })

export default function balancer(hosts: string[], proxyURL: string, options?: BalancerOptions) {
  if (!options) {
    options = {}
  }
  if (!options.healthURL) {
    options.healthURL
  }

  const url = new URL(proxyURL)
  const backends = hosts.map((h) => {
    const u = new URL(url.pathname, new URL(h))
    return <Backend>{
      host: h,
      proxy: proxy(u.toString(), options),
      requestCount: 0,
      statuses: [],
      lastError: 0,
      healthScore: 0,
      errorCount: 0
    }
  })
  let count = 0
  let lastError = Date.now()

  return async function fetchBalancer(req: RequestInfo, init?: RequestInit | undefined): Promise<Response> {
    if (typeof req === "string") {
      req = new Request(req)
    }
    const attempted: { [key: string]: Backend } = {}
    while (Object.getOwnPropertyNames(attempted).length < backends.length) {
      let backend = null
      const [backendA, backendB] = chooseBackends(backends, attempted)

      if (!backendA) {
        return new Response("No backend available", { status: 502 })
      }
      if (!backendB) {
        backend = backendA
      } else {
        // randomize between 2 good candidates
        backend = (Math.floor(Math.random() * 2) == 0) ? backendA : backendB
      }

      backend.requestCount += 1
      attempted[backend.host] = backend

      let resp: Response | null
      try {
        resp = await backend.proxy(req, init)
        resp.headers.set("Fly-Backend", backend.host.replace(/^http:\/\/\d+\.\d+\.\d+\.(\d+):7000/, "$1"))
      } catch (e) {
        resp = proxyError
      }
      backend.statuses.push(resp ? resp.status : 500)
      if (backend.statuses.length > 10) {
        backend.statuses = backend.statuses.slice(-10)
      }
      if (resp.status >= 500 && resp.status < 600) {
        backend.lastError = Date.now()
        lastError = Date.now()

        if (canRetry(req, resp)) resp = null

      } else {
        // got a good response :partyparrot:
      }
      backend.healthScore = score(backend)

      if (resp) return resp
    }

    return proxyError
  }
}

export interface Backend {
  host: string,
  proxy: (req: RequestInfo, init?: RequestInit | undefined) => Promise<Response>,
  requestCount: 0,
  statuses: number[],
  lastError: number,
  healthScore: number,
  errorCount: 0
}
// compute a backend health score with time + status codes
function score(backend: Backend, errorBasis?: number) {
  if (typeof errorBasis !== "number" && !errorBasis) errorBasis = Date.now()

  const timeSinceError = (errorBasis - backend.lastError)
  const statuses = backend.statuses
  const timeWeight = (backend.lastError === 0 && 0) ||
    ((timeSinceError < 1000) && 1) ||
    ((timeSinceError < 3000) && 0.8) ||
    ((timeSinceError < 5000) && 0.3) ||
    ((timeSinceError < 10000) && 0.1) ||
    0;
  if (statuses.length == 0) return 0
  let requests = statuses.length
  let errors = 0
  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i]
    if (status >= 500 && status < 600) {
      errors += 1
    }
  }
  const score = (1 - (timeWeight * (errors / requests)))
  return score
}
function canRetry(req: Request, resp: Response) {
  if (resp && resp.status < 500) return false // don't retry normal boring errors or success
  if (req.method == "GET" || req.method == "HEAD") return true
  return false
}

function chooseBackends(backends: Backend[], attempted: { [key: string]: Backend }) {
  let backendA: Backend | null = null
  let backendB: Backend | null = null
  for (let i = 0; i < backends.length; i++) {
    const b = backends[i]
    if (attempted[b.host]) continue;

    if (!backendA) {
      backendA = b
      continue
    }

    if (!backendB) {
      backendB = b
      continue
    }

    if (
      b.healthScore > backendA.healthScore ||
      (b.healthScore == backendA.healthScore && b.requestCount < backendA.requestCount)
    ) {
      // better backend candidate
      console.log("scores a:", backendA.healthScore, b.healthScore)
      backendA = b
      continue
    }
    if (
      b.requestCount <= backendB.requestCount ||
      (b.healthScore == backendB.healthScore && b.requestCount < backendB.requestCount)
    ) {
      // better backend candidate
      console.log("scores b:", backendB.healthScore, b.healthScore)
      backendB = b
      continue
    }
  }

  return [backendA, backendB]
}

export const _internal = {
  chooseBackends,
  score
}
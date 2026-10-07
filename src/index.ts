import type { Env } from './shared';
export { BtbHub } from './hub';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One durable coordinator is intentional for a small personal network. Its name is
    // stable across deployments; never replace it to solve a deployment problem.
    return env.HUB.get(env.HUB.idFromName('btb-hub-v1')).fetch(request);
  }
} satisfies ExportedHandler<Env>;

// Launching headless Chromium with the best available WebGL backend.
//
// On Windows the D3D11 ANGLE backend in Playwright's headless shell gives real
// GPU WebGL (e.g. "ANGLE (NVIDIA ... Direct3D11)"). If that yields no WebGL or
// only SwiftShader, we try the other candidates and finally accept SwiftShader
// (software, slow but correct). The chosen backend is logged.
import { chromium, type Browser, type LaunchOptions } from 'playwright';

export interface WebGlInfo {
  renderer: string;
  vendor: string;
  version: string;
  /** True for SwiftShader / llvmpipe / other CPU rasterizers. */
  software: boolean;
}

export interface LaunchCandidate {
  name: string;
  options: LaunchOptions;
}

export type GpuMode = 'auto' | 'gpu' | 'software';

const GPU_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
const COMMON_ARGS = [
  // A background tab must not throttle timers/rAF while we wait for widgets.
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  // The page is http://127.0.0.1; allow plenty of WebGL contexts (studio + probes).
  '--max-active-webgl-contexts=32',
];

/** Ordered launch candidates for a mode. Exported for tests/diagnostics. */
export function launchCandidates(mode: GpuMode, platform = process.platform, extraArgs: string[] = []): LaunchCandidate[] {
  const gpuAngle = platform === 'win32' ? ['--use-angle=d3d11'] : platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=gl'];
  const mk = (name: string, args: string[], channel?: string): LaunchCandidate => ({
    name,
    options: { headless: true, ...(channel ? { channel } : {}), args: [...COMMON_ARGS, ...args, ...extraArgs] },
  });
  const software = mk('swiftshader', ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
  if (mode === 'software') return [software];
  const gpu = [
    mk(`headless-shell ${gpuAngle[0]}`, [...gpuAngle, ...GPU_ARGS]),
    // "New headless" (full Chromium) sometimes gets GPU access where the shell does not.
    mk(`new-headless ${gpuAngle[0]}`, [...gpuAngle, ...GPU_ARGS], 'chromium'),
    mk('headless-shell default-gl', GPU_ARGS),
  ];
  return mode === 'gpu' ? gpu : [...gpu, software];
}

export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render driver|microsoft basic/i.test(renderer);
}

/** Queries the WebGL backend of a fresh page in `browser`. Null if WebGL is unavailable. */
export async function probeWebGl(browser: Browser): Promise<WebGlInfo | null> {
  const page = await browser.newPage();
  try {
    const r = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const res = {
        renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
        vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
        version: String(gl.getParameter(gl.VERSION)),
      };
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return res;
    });
    return r ? { ...r, software: isSoftwareRenderer(r.renderer) } : null;
  } finally {
    await page.close().catch(() => {});
  }
}

export interface LaunchedBrowser {
  browser: Browser;
  candidate: LaunchCandidate;
  webgl: WebGlInfo;
}

/**
 * Tries candidates in order and returns the first with hardware WebGL; if none
 * has hardware WebGL, the first with any WebGL. Throws if WebGL is unavailable
 * everywhere (the mirror cannot work at all then).
 */
export async function launchBestBrowser(
  candidates: LaunchCandidate[],
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<LaunchedBrowser> {
  let softwareFallback: LaunchedBrowser | null = null;
  const failures: string[] = [];
  for (const candidate of candidates) {
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch(candidate.options);
      const webgl = await probeWebGl(browser);
      if (!webgl) {
        failures.push(`${candidate.name}: no WebGL`);
        await browser.close().catch(() => {});
        continue;
      }
      if (!webgl.software) {
        if (softwareFallback) await softwareFallback.browser.close().catch(() => {});
        return { browser, candidate, webgl };
      }
      failures.push(`${candidate.name}: software (${webgl.renderer})`);
      if (!softwareFallback) softwareFallback = { browser, candidate, webgl };
      else await browser.close().catch(() => {});
    } catch (e) {
      failures.push(`${candidate.name}: ${(e as Error).message.split('\n')[0]}`);
      if (browser) await browser.close().catch(() => {});
    }
  }
  if (softwareFallback) {
    log('warn', `mirror: no hardware WebGL available, using software rendering (slow). Tried: ${failures.join('; ')}`);
    return softwareFallback;
  }
  throw new Error(`mirror: could not launch Chromium with WebGL. Tried: ${failures.join('; ')}`);
}

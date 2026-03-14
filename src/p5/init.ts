import p5 from "p5";

declare global {
    interface Window {
        __CONTOUR_P5__?: p5;
    }
}

type InitParams = {
    setup?: () => void;
    draw?: () => void;
    windowResized?: () => void;
    keyPressed?: () => void;
}

type P5Constructor = {
    new(sketch?: ((instance: p5) => void) | undefined, node?: HTMLElement): p5;
}

export function initP5(params: InitParams, node?: HTMLElement) {
    Object.assign(window, params);
    const P5 = p5 as unknown as P5Constructor;
    window.__CONTOUR_P5__?.remove();
    window.__CONTOUR_P5__ = new P5(undefined, node);
}

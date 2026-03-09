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

export function initP5(params: InitParams) {
    Object.assign(window, params);
    const P5 = p5 as unknown as { new (): p5 };
    window.__CONTOUR_P5__ = new P5();
}

import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement scrolling; framer-motion calls it when measuring keyframes.
window.scrollTo = () => undefined;

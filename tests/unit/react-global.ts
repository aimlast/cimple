/**
 * The CIM renderers are compiled with the classic JSX transform (tsconfig
 * "jsx": "preserve" → React.createElement), and some build JSX at module
 * load. Import this FIRST in a test that renders them.
 */
import React from "react";

(globalThis as any).React = React;

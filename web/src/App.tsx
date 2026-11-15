import { Button } from '@nkzw/codiff-core/react';
import { GithubLogoIcon as GithubLogo } from '@phosphor-icons/react/GithubLogo';
import Header from './Header.tsx';
import HomeGuide from './HomeGuide.tsx';

const NakazawaTechLogo = () => (
  <svg
    aria-hidden
    className="codiff-web-footer-logo"
    viewBox="100 300 900 600"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient
        gradientUnits="userSpaceOnUse"
        id="nakazawa-gradient"
        x1="771.22"
        x2="451.18"
        y1="808.32"
        y2="856.73"
      >
        <stop offset="0" stopColor="#3d87f5" />
        <stop offset=".53" stopColor="#a855f7" />
        <stop offset="1" stopColor="#d946ef" />
      </linearGradient>
      <linearGradient
        href="#nakazawa-gradient"
        id="nakazawa-gradient-2"
        x1="362.58"
        x2="752.54"
        y1="285.94"
        y2="205.26"
      />
      <linearGradient
        href="#nakazawa-gradient"
        id="nakazawa-gradient-3"
        x1="372.48"
        x2="762.44"
        y1="333.79"
        y2="253.11"
      />
      <linearGradient
        href="#nakazawa-gradient"
        id="nakazawa-gradient-4"
        x1="363.56"
        x2="753.52"
        y1="290.67"
        y2="209.99"
      />
      <linearGradient
        href="#nakazawa-gradient"
        id="nakazawa-gradient-5"
        x1="771.54"
        x2="451.5"
        y1="810.46"
        y2="858.87"
      />
      <linearGradient
        gradientUnits="userSpaceOnUse"
        id="nakazawa-gradient-6"
        x1="860.16"
        x2="860.16"
        y1="749.93"
        y2="313.74"
      >
        <stop offset="0" stopColor="#3d87f5" />
        <stop offset=".53" stopColor="#a855f7" />
        <stop offset="1" stopColor="#d946ef" />
      </linearGradient>
      <linearGradient
        gradientUnits="userSpaceOnUse"
        id="nakazawa-gradient-7"
        x1="224.24"
        x2="224.24"
        y1="786.73"
        y2="396.02"
      >
        <stop offset="0" stopColor="#d946ef" />
        <stop offset=".47" stopColor="#a855f7" />
        <stop offset="1" stopColor="#3d87f5" />
      </linearGradient>
    </defs>
    <path
      d="M678.76 833.83c-21.94 5.07-44.5 5.7-58.42-3.56-.29-11.52-12.1-29.46-27.47-33.44-16.47-4.02-31.46.04-41.28 10.98-4.19-18.82-45.33-47.27-76.16-9.59-21.69 34.1 55.89 112.64 158.7 99.35 30.44-4.72 55.27-13.24 75.53-24.12l-31.57-39.46c.23-.05.45-.11.68-.17Z"
      fill="url(#nakazawa-gradient)"
    />
    <path
      d="M433.64 265.39c23.56-16.38 81.71-35.21 108.04-17.7-.41 10.82 15.03 29.3 26.7 32.5 16.01 3.91 30.22 1.08 40.29-9.53 2.19 14.11 42.88 43.62 73.86 8.18 20.44-26.27-54.32-109.48-154.25-96.56-80.24 12.44-120.52 52.02-140.05 91.01l15.58 19.46c9.38-11.84 19.5-20.17 29.83-27.35Z"
      fill="url(#nakazawa-gradient-2)"
    />
    <path
      d="M491.37 323.73c10.41 9.79 39.18 11.47 38.95-10.94.23-10.3-11.82-27.14-50.99-26.12-23.07.9-42.66 12.24-58.35 27.53l13.41 16.74c17.57-11.33 49.78-13.99 56.98-7.21Z"
      fill="url(#nakazawa-gradient-3)"
    />
    <path
      d="M332.41 709.93V364.65l150.44 188.03 49.59-61.98-179.11-223.68h-90.88v343.03c6.83 20.91 16.76 40.5 29.65 58.25 11.43 15.75 24.97 29.69 40.31 41.63ZM770.75 441.24V788.3l-158.8-198.31-49.64 62L741.3 875.7h99.41V487.84c-.76-.77-1.51-1.56-2.31-2.31-20.33-19.05-43.08-33.93-67.65-44.29Z"
      fill="currentColor"
    />
    <path
      d="M741.3 266.98 306.01 811.01c-4.81-1.19-9.58-2.59-13.19-4.13-7.85-2.79-24.79-12.74-24.79-12.74l-5.59-.88v82.39h90.88L840.7 267l-99.41-.02Z"
      fill="currentColor"
    />
    <path
      d="M665.23 205.89c8.22-8.39 39.91-19.57 66.91-3.1 15.71 9.85 13.72 25.11 9.38 31.41-7.14 12.24-32.37 16.41-41.64-13.05-1.94-7.46-21.86-16.61-34.65-15.27Z"
      fill="url(#nakazawa-gradient-4)"
    />
    <path
      d="M492 873.24c-8.46 8.63-41.07 20.13-68.84 3.19-16.17-10.13-14.11-25.83-9.66-32.32 7.35-12.6 35.86-17.48 41.55 15.73 2 7.68 23.79 14.78 36.95 13.39Z"
      fill="url(#nakazawa-gradient-5)"
    />
    <path
      d="M945.09 483.67c14.11-70.16-41.22-140.41-108.79-168.64-1.04-.44-2.09-.87-3.14-1.29l-15.38 19.21c77.25 21.75 108.43 100.86 106.42 116.79-19.93-27.68-25.54-40.89-85.51-75.49-13.28-6.73-27.01-12.11-40.98-16.23l-42.4 52.94c36 10.71 69.83 30.19 99.03 57.55 47.76 44.75 38.23 118.22 9.69 180.47v40.24c8.24-10.93 15.57-22.26 21.26-32.97 21.53-40.55 27.03-78.5 31.57-105.01 12.53 15.77 11.89 60.1.94 86.21-6.98 18.89-25.06 50.59-53.76 83.59v28.89c41.11-34.07 73-73.83 87.59-111.79 33.53-87.24-6.53-154.47-6.53-154.47Z"
      fill="url(#nakazawa-gradient-6)"
    />
    <path
      d="M333.48 739.37c-69.13-45.45-107.28-121.99-105.36-206.64.36-16.02 4.32-30.62 11.02-43.85V375.09C192.78 410.64 178.89 455 178.89 455c-61.69 36.28-77.12 124.36-53.08 193.54 25.05 73.4 103.52 119.74 150.44 123.01 6.81 4.55 14.02 8.68 21.56 12.42l35.68-44.6Zm-180.72-79.68c-45.71-73.83-5.49-152.52 14.78-166.48-7.33 33.31-13.43 46.3.79 114.06 15.18 56.81 50.72 104.91 94.2 137.97-8.67-1.86-64.06-11.72-109.77-85.55Z"
      fill="url(#nakazawa-gradient-7)"
    />
  </svg>
);

export default function App() {
  return (
    <div className="codiff-web-shell">
      <Header />
      <HomeGuide />

      <footer className="codiff-web-footer">
        <div className="codiff-web-footer-inner">
          <div className="codiff-web-footer-credit">
            <a
              aria-label="Open Nakazawa Tech"
              className="codiff-web-footer-brand"
              href="https://nakazawa.tech"
              rel="noreferrer"
              target="_blank"
            >
              <NakazawaTechLogo />
            </a>
            <p>
              Created by{' '}
              <a href="https://nakazawa.tech" rel="noreferrer" target="_blank">
                Nakazawa Tech
              </a>{' '}
              <span aria-hidden>•</span> Tokens sponsored by{' '}
              <a href="https://www.cloudflare.com" rel="noreferrer" target="_blank">
                Cloudflare
              </a>{' '}
              &amp;{' '}
              <a href="https://openai.com" rel="noreferrer" target="_blank">
                OpenAI
              </a>
            </p>
          </div>
          <Button asChild className="codiff-web-footer-github" size="sm" variant="outline">
            <a href="https://github.com/nkzw-tech/codiff" rel="noreferrer" target="_blank">
              <GithubLogo aria-hidden size={18} weight="regular" />
              Star on GitHub
            </a>
          </Button>
        </div>
      </footer>
    </div>
  );
}

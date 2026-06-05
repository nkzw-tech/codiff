import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/ArrowRight';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/ArrowsClockwise';
import { BugIcon as Bug } from '@phosphor-icons/react/Bug';
import { CaretLeftIcon as CaretLeft } from '@phosphor-icons/react/CaretLeft';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/CaretRight';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { FileIcon as File } from '@phosphor-icons/react/File';
import { FilePlusIcon as FilePlus } from '@phosphor-icons/react/FilePlus';
import { FlaskIcon as Flask } from '@phosphor-icons/react/Flask';
import { GearIcon as Gear } from '@phosphor-icons/react/Gear';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/GitBranch';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { ReadCvLogoIcon as Doc } from '@phosphor-icons/react/ReadCvLogo';
import { WrenchIcon as Wrench } from '@phosphor-icons/react/Wrench';
import type { ComponentType } from 'react';
import type { WalkthroughIcon } from '../../../types.ts';

type IconProps = {
  size?: number;
  weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
};

/** Phosphor components for the icon names a walkthrough phase may use. */
export const phaseIcons: Record<WalkthroughIcon, ComponentType<IconProps>> = {
  beaker: Flask,
  bug: Bug,
  doc: Doc,
  flask: Flask,
  gear: Gear,
  path: Path,
  wrench: Wrench,
};

export {
  ArrowRight,
  ArrowsClockwise,
  CaretLeft,
  CaretRight,
  Check,
  File,
  FilePlus,
  GitBranch,
  Path,
};

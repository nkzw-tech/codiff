import type { CodiffKeymap } from '../config/types.ts';

export type Command = {
  description?: () => string | null;
  execute: () => void;
  id: string;
  keymapAction?: keyof CodiffKeymap;
  title: string;
};

export type CommandRegistry = {
  commands: ReadonlyArray<Command>;
  register: (command: Command) => () => void;
};

export const createCommandRegistry = (): CommandRegistry => {
  let commands: Array<Command> = [];

  return {
    get commands() {
      return commands;
    },
    register(command: Command) {
      commands = [...commands, command];

      return () => {
        commands = commands.filter((c) => c.id !== command.id);
      };
    },
  };
};

export const filterCommands = (
  commands: ReadonlyArray<Command>,
  query: string,
): ReadonlyArray<Command> => {
  const trimmed = query.trim().toLowerCase();

  if (!trimmed) {
    return commands;
  }

  return commands.filter((command) => {
    const title = command.title.toLowerCase();
    let queryIndex = 0;

    for (let i = 0; i < title.length && queryIndex < trimmed.length; i++) {
      if (title[i] === trimmed[queryIndex]) {
        queryIndex++;
      }
    }

    return queryIndex === trimmed.length;
  });
};

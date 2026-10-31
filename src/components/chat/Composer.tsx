"use client";

import type { RefObject } from "react";
import Link from "next/link";
import { FileText, Loader2, Send, Square, X } from "lucide-react";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import type { Settings } from "@/lib/store";
import type { Attachment, Msg } from "@/components/chat/types";
import { COMMANDS } from "@/components/chat/commands";

type ComposerProps = {
  input: string;
  setInput: (v: string) => void;
  attachments: Attachment[];
  setAttachments: (v: Attachment[] | ((prev: Attachment[]) => Attachment[])) => void;
  messages: Msg[];
  settings: Settings;
  provider: ProviderId;
  model: string;
  loading: boolean;
  stopping: boolean;
  modelMenuOpen: boolean;
  setModelMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  PIcon: typeof Send;
  autosize: () => void;
  handleFiles: (files: FileList | File[]) => void;
  send: (text?: string) => void;
  setSettings: (s: Settings) => void;
  saveSettings: (s: Settings) => void;
  stopRun: () => void;
};

export default function Composer({
  input,
  setInput,
  attachments,
  setAttachments,
  messages,
  settings,
  provider,
  model,
  loading,
  stopping,
  modelMenuOpen,
  setModelMenuOpen,
  taRef,
  PIcon,
  autosize,
  handleFiles,
  send,
  setSettings,
  saveSettings,
  stopRun,
}: ComposerProps) {
  const showCommands = input.startsWith("/") && !input.includes("\n");
  const matches = showCommands
    ? COMMANDS.filter((c) => c.name.startsWith(input.slice(1).split(/\s/)[0].toLowerCase()))
    : [];
  return (
    <div className="px-4 pb-5 sm:px-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="relative mx-auto w-full max-w-2xl"
      >
        {!!matches.length && (
          <div className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-2xl border border-white/15 bg-zinc-950 shadow-2xl">
            {matches.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => setInput(`/${c.name} `)}
                className="block w-full px-4 py-2.5 text-left transition hover:bg-white/10"
              >
                <span className="text-xs font-bold text-white">/{c.name}</span>
                <span className="ml-2 text-[11px] text-zinc-500">{c.desc}</span>
                <span className="mt-0.5 block text-[10px] text-zinc-600">{c.usage}</span>
              </button>
            ))}
          </div>
        )}
        <div
          className="glass rounded-3xl p-2 shadow-2xl shadow-black focus-within:border-white/40"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); handleFiles(event.dataTransfer.files); }}
        >
          {!!attachments.length && <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {attachments.map((file) => <span key={file.name} className="flex items-center gap-1 rounded-full border border-white/10 bg-white/8 px-2 py-1 text-[10px] text-zinc-300"><FileText size={11} /> {file.name}<button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.name !== file.name))} className="ml-1 text-zinc-500 hover:text-white"><X size={11} /></button></span>)}
          </div>}
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autosize();
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                send();
                return;
              }
              if (e.key === "ArrowUp" && !input && messages.length) {
                const previous = [...messages].reverse().find((m) => m.role === "user");
                if (previous) {
                  e.preventDefault();
                  setInput(previous.content);
                  requestAnimationFrame(autosize);
                }
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            maxLength={2000}
            placeholder={`Ask Anything about QA`}
            className="max-h-40 w-full resize-none bg-transparent px-4 pt-3 text-sm text-white outline-none placeholder:text-zinc-600"
          />
          <div className="flex items-center gap-2 px-2 pb-1">
             <label className="grid h-8 w-8 cursor-pointer place-items-center rounded-xl text-zinc-500 hover:bg-white/10 hover:text-white" title="Attach text file">
               <FileText size={14} />
                <input type="file" multiple accept=".txt,.md,.json,.js,.ts,.tsx,.jsx,.xml,.yaml,.yml,.csv,.log,.xls,.xlsx,.xlsm,.xlsb,.pdf,.docx,.doc,.ppt,.pptx,.odt,.ods,.odp,.rtf,.epub" className="hidden" onChange={(event) => { if (event.target.files) handleFiles(event.target.files); event.currentTarget.value = ""; }} />
             </label>
             <div className="relative hidden sm:block">
              <button
                type="button"
                onClick={() => setModelMenuOpen((open) => !open)}
                className="flex items-center gap-1.5 rounded-full bg-white/8 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-white/15 hover:text-white"
                aria-expanded={modelMenuOpen}
                 title="Change model"
              >
                <PIcon size={12} className="text-white" /> {model}
              </button>
              {modelMenuOpen && (
                <div className="absolute bottom-9 left-0 z-30 min-w-48 rounded-xl border border-white/15 bg-zinc-950 p-1.5 shadow-2xl">
                   <p className="px-2 py-1 text-[10px] uppercase tracking-widest text-zinc-600">Choose a model</p>
                  {[...new Set([...PROVIDERS[provider].models, model])].map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        const next = { ...settings, model: option };
                        setSettings(next);
                        saveSettings(next);
                        setModelMenuOpen(false);
                      }}
                      className={`block w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-white/10 ${option === model ? "text-white" : "text-zinc-400"}`}
                    >
                      {option}
                       {option === model && <span className="float-right text-zinc-500">active</span>}
                    </button>
                  ))}
                   <Link href="/settings" className="mt-1 block border-t border-white/10 px-2 pt-2 text-[11px] text-zinc-500 hover:text-white">Manage provider & custom model →</Link>
                </div>
              )}
            </div>
            <span className="ml-auto text-[10px] text-zinc-600">{input.length}/2000</span>
            {loading ? (
                <button
                  type="button"
                  onClick={() => stopRun()}
                  disabled={stopping}
                  title="Stop agent"
                className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-black shadow-lg shadow-white/10 transition hover:bg-zinc-200 active:scale-95"
              >
                 {stopping ? <Loader2 size={15} className="animate-spin" /> : <Square size={15} fill="currentColor" />}
              </button>
            ) : (
              <button
                disabled={!input.trim() && !attachments.length}
                className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-black shadow-lg shadow-white/10 transition hover:bg-zinc-200 active:scale-95 disabled:opacity-30"
              >
                <Send size={17} />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Search, ArrowUpRight } from 'lucide-react';
import { routeManifest } from '../lib/routes';

export function CommandPalette() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const results = routeManifest.filter(route => !route.path.includes('[') && (route.title + ' ' + route.path).toLowerCase().includes(query.toLowerCase())).slice(0, 9);
  useEffect(() => { function onKey(event: KeyboardEvent) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); dialog.current?.showModal(); } } document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, []);
  return <><button className="search-trigger" onClick={() => dialog.current?.showModal()} aria-label="Search pages"><Search size={16} aria-hidden="true" /><span>Search pages</span><kbd>⌘ K</kbd></button><dialog ref={dialog} className="command-dialog" aria-labelledby="search-title"><div className="dialog-heading"><h2 id="search-title">Find a page</h2><button className="icon-button" onClick={() => dialog.current?.close()} aria-label="Close search">×</button></div><label className="sr-only" htmlFor="page-search">Search by page title or URL</label><input autoFocus id="page-search" type="search" placeholder="Wallets, vouchers, security…" value={query} onChange={event => setQuery(event.target.value)} /><p className="small muted">Page navigation · Full-text documentation search is coming in the docs stage.</p><ul className="search-results">{results.map(route => <li key={route.id}><Link href={route.path} onClick={() => dialog.current?.close()}><span>{route.title}<small>{route.path}</small></span><ArrowUpRight size={16} aria-hidden="true" /></Link></li>)}</ul>{results.length === 0 && <p>No pages match your search.</p>}<p className="small muted">Use Tab to navigate · Escape to close</p></dialog></>;
}

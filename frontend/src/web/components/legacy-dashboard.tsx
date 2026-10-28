'use client';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Button } from './ui';
const ExistingDashboard=dynamic(()=>import('../../App'),{ssr:false,loading:()=> <p role="status">Loading existing dashboard…</p>});
export function LegacyDashboard(){const[open,setOpen]=useState(false);return <section className="legacy-dashboard"><div><h2>Existing dashboard</h2><p className="muted small">The original wallet connection and protocol-information view remains accessible during migration.</p></div><Button variant="secondary" onClick={()=>setOpen(!open)} aria-expanded={open}>{open?'Hide existing dashboard':'Open existing dashboard'}</Button>{open&&<ExistingDashboard/>}</section>;}

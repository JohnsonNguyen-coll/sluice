import type { Metadata } from 'next';
import { routeById, type RouteId } from './routes';
export function pageMetadata(id: RouteId): Metadata {
 const route = routeById(id);
 return { title: route.title, description: route.description, alternates: route.path.includes('[') ? undefined : { canonical: route.path }, robots: route.area === 'app' ? { index: false, follow: false } : undefined };
}

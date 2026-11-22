import { instancesPage } from '@peblish/core/peers/public';
import { createServerFn } from '@tanstack/react-start';

/**
 * The public Instances page's data: core's narrow projection, sent as it is (the rows' domain and
 * software, nothing else). Public and the same for everyone, so it reads no session.
 */
export const loadInstances = createServerFn({ method: 'GET' }).handler(() => instancesPage());

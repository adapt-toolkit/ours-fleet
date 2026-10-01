import {it,expect} from 'vitest';
import {validateAccountOrigin} from '../src/account-origin.js';
it('accepts exactly the production and Owner-controlled test HTTPS account origins',()=>{
 for(const origin of ['https://app.ours.network','https://app.ours-tunnel.com'])expect(validateAccountOrigin(origin)).toBe(origin);
 for(const origin of [undefined,'http://app.ours-tunnel.com','https://app.ours-tunnel.com:443','https://app.ours-tunnel.com/','https://app.ours-tunnel.com/path','https://user@app.ours-tunnel.com','https://app.ours-tunnel.com.attacker.invalid','https://random.ours-tunnel.com'])expect(()=>validateAccountOrigin(origin)).toThrow('Unsupported');
});

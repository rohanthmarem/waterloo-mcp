import { afterEach, describe, expect, it, vi } from 'vitest';
import { courseFilePath } from '../../src/api/course-file.js';
import { D2LApiClient } from '../../src/api/client.js';
const base = 'https://learn.example.edu';
const file = '/content/enforced/123-MATH135/media/W2.pdf?isCourseFile=true';
const token = { accessToken: 'api-bearer', cookieHeader: 'd2lSessionVal=private', tenantOrigin: base, capturedAt: Date.now(), expiresAt: Date.now()+3600000, source: 'browser' };
const client = (extra = {}) => new D2LApiClient({baseUrl:base, tokenManager:{getToken:vi.fn(async()=>token)} as any,retry:{maxRetries:0},...extra});
afterEach(()=>vi.unstubAllGlobals());
describe('linked course file cookie access',()=>{
  it('accepts absolute and relative same-course file URLs',()=>{
    expect(courseFilePath(base,123,file)).toBe(file);
    expect(courseFilePath(base,123,base+file)).toBe(file);
  });
  it.each([
    'https://attacker.example/content/enforced/123-MATH135/W2.pdf',
    '/content/enforced/1234-MATH135/W2.pdf',
    '/content/enforced/456-MATH135/W2.pdf',
    '/d2l/login',
    '/content/enforced/123-MATH135/%2f..%2fsecret',
    '/content/enforced/123-MATH135/%252e%252e/secret',
    '/content/enforced/123-MATH135/W2.pdf?action=delete',
    'https://u:p@learn.example.edu/content/enforced/123-MATH135/W2.pdf',
  ])('rejects unsafe or different-course URL %s', async (url)=>{
    const fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
    await expect(client().getCourseFile(123,url)).rejects.toThrow('INVALID_COURSE_FILE_URL');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses session cookies, not the API bearer, and disables automatic redirects', async()=>{
    const fetch = vi.fn(async()=>new Response('%PDF-1.7', {headers:{'content-type':'application/pdf'}}));vi.stubGlobal('fetch',fetch);
    const result=await client().getCourseFile(123,file);
    expect(await result.text()).toBe('%PDF-1.7');
    expect(fetch).toHaveBeenCalledWith(base+file,expect.objectContaining({redirect:'manual',headers:expect.objectContaining({Cookie:'d2lSessionVal=private'})}));
    expect((fetch.mock.calls[0] as any)[1].headers.Authorization).toBeUndefined();
  });
  it('does not forward cookies to external or another course redirects', async()=>{
    for (const location of ['https://attacker.example/collect','/content/enforced/456-MATH135/W2.pdf']) {
      const fetch=vi.fn(async()=>new Response(null,{status:302,headers:{location}}));vi.stubGlobal('fetch',fetch);
      await expect(client().getCourseFile(123,file)).rejects.toMatchObject({status:400});
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('permits same-course redirects and returns the final bytes', async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'W2-final.pdf'}})).mockResolvedValueOnce(new Response('%PDF-ok'));
    vi.stubGlobal('fetch',fetch);expect(await (await client().getCourseFile(123,file)).text()).toBe('%PDF-ok');
    expect(fetch.mock.calls[1][0]).toBe(base+'/content/enforced/123-MATH135/media/W2-final.pdf');
  });
  it('treats a login redirect as expired authentication without fetching its URL', async()=>{
    const fetch=vi.fn(async()=>new Response(null,{status:302,headers:{location:'https://adfs.example.edu/adfs/ls/'}}));vi.stubGlobal('fetch',fetch);
    await expect(client().getCourseFile(123,file)).rejects.toMatchObject({status:401});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects HTML sign-in forms rather than reporting them as file contents',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('<form action="/d2l/login"><input type="password"></form>',{headers:{'content-type':'text/html'}})));
    await expect(client().getCourseFile(123,file)).rejects.toMatchObject({status:401});
  });
});

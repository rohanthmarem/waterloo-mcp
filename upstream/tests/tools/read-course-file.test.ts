import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerReadCourseFile, readBoundedCourseFile } from '../../src/tools/read-course-file.js';
import { registerDownloadFile } from '../../src/tools/download-file.js';
function tool(register: Function, api: any) {
  let handler: any;
  register({registerTool:(_name:any,_schema:any,fn:any)=>{handler=fn}},api);
  return handler;
}
const fileUrl='/content/enforced/123-MATH135/media/W2.txt';
describe('read linked LEARN course files',()=>{
  it('returns paged text without saving a file',async()=>{
    const getCourseFile=vi.fn(async()=>new Response('abcdef',{headers:{'content-type':'text/plain'}}));
    const result=await tool(registerReadCourseFile,{getCourseFile})({courseId:123,fileUrl,offset:1,maxChars:3});
    expect(getCourseFile).toHaveBeenCalledWith(123,fileUrl);
    expect(JSON.parse(result.content[0].text)).toMatchObject({text:'bcd',nextOffset:4,totalChars:6,saved:false,bytes:6});
  });
  it('reports a false PDF instead of silently returning empty extraction',async()=>{
    const result=await tool(registerReadCourseFile,{getCourseFile:async()=>new Response('<html>sign in</html>',{headers:{'content-type':'text/html'}})})({courseId:123,fileUrl:fileUrl.replace('.txt','.pdf'),offset:0,maxChars:100});
    expect(result.isError).toBe(true);expect(result.content[0].text).toMatch(/^COURSE_FILE_NOT_PDF:/);
  });
  it('bounds bytes both by advertised size and actual stream length',async()=>{
    await expect(readBoundedCourseFile(new Response('abc',{headers:{'content-length':'300'}}),2)).rejects.toThrow('COURSE_FILE_TOO_LARGE');
    await expect(readBoundedCourseFile(new Response('abc'),2)).rejects.toThrow('COURSE_FILE_TOO_LARGE');
  });
  it('saves linked files only through download_file and reports a server path, not a chat attachment',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'course-file-'));
    try {
      const getCourseFile=vi.fn(async()=>new Response('hello course file',{headers:{'content-type':'text/plain'}}));
      const result=await tool(registerDownloadFile,{getCourseFile})({courseId:123,fileUrl,downloadPath:dir});
      expect(result.isError).not.toBe(true);
      const data=JSON.parse(result.content[0].text);
      expect(await readFile(data.filePath,'utf8')).toBe('hello course file');
      expect(data.message).toContain('not an attachment');
    } finally {await rm(dir,{recursive:true,force:true})}
  });
  it('rejects ambiguous download sources before reading or writing',async()=>{
    const getCourseFile=vi.fn();
    const result=await tool(registerDownloadFile,{getCourseFile})({courseId:123,fileUrl,topicId:456,downloadPath:'/state/downloads'});
    expect(result.isError).toBe(true);expect(result.content[0].text).toMatch(/^INVALID_FILE_SOURCE:/);expect(getCourseFile).not.toHaveBeenCalled();
  });
});

describe('course file access errors',()=>{
  it('reports access denied without incorrectly asking to replace the saved login',async()=>{
    const {ApiError}=await import('../../src/api/errors.js');
    const result=await tool(registerReadCourseFile,{getCourseFile:async()=>{throw new ApiError(403,'/content/enforced/123/file','denied')}})({courseId:123,fileUrl,offset:0,maxChars:100});
    expect(result.isError).toBe(true);expect(result.content[0].text).toContain('Access denied');expect(result.content[0].text).not.toContain('npm run login');
  });
  it('reports a blocked redirect without leaking a destination URL',async()=>{
    const {ApiError}=await import('../../src/api/errors.js');
    const result=await tool(registerReadCourseFile,{getCourseFile:async()=>{throw new ApiError(400,'/content/enforced/123/file','COURSE_FILE_REDIRECT_BLOCKED')}})({courseId:123,fileUrl,offset:0,maxChars:100});
    expect(result.content[0].text).toMatch(/^COURSE_FILE_REDIRECT_BLOCKED:/);
  });
});

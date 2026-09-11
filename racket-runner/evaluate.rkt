#lang racket/base
(require racket/sandbox json)
(define input (read-json))
(define language (string->symbol (hash-ref input 'language)))
(unless (memq language '(racket htdp/bsl htdp/bsl+ htdp/isl htdp/isl+ htdp/asl))
  (error 'language "Unsupported language"))
(define module-language
  (hash-ref (hash 'htdp/bsl 'lang/htdp-beginner
                  'htdp/bsl+ 'lang/htdp-beginner-abbr
                  'htdp/isl 'lang/htdp-intermediate
                  'htdp/isl+ 'lang/htdp-intermediate-lambda
                  'htdp/asl 'lang/htdp-advanced)
            language language))
;; Never use a trusted sandbox configuration. Readers and language are fixed.
(with-handlers ([exn:fail:resource?
                 (lambda (e)
                   (define timed-out? (eq? (exn:fail:resource-resource e) 'time))
                   (displayln (if timed-out? "Evaluation time limit exceeded." "Evaluation memory limit exceeded.") (current-error-port))
                   (exit (if timed-out? 124 125)))])
(parameterize ([sandbox-output (current-output-port)]
               [sandbox-error-output (current-error-port)]
               [sandbox-input #f]
               [sandbox-memory-limit 128]
               [sandbox-eval-limits '(5 128)]
               [sandbox-path-permissions '()]
               [sandbox-network-guard (lambda args (error 'network "Network access denied"))]
               [sandbox-make-environment-variables make-environment-variables]
               [sandbox-run-submodules '(test)])
  (define evaluator
    (make-module-evaluator
     (string-append "#lang " (symbol->string language) "\n" (hash-ref input 'code))
     #:language module-language
     #:readers (default-language-readers language)))
  (kill-evaluator evaluator)))
